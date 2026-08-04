# Implementation

This document describes the code and runtime shape in this repository.
Externally observable API behaviour is specified in [service-contract.md](service-contract.md).

## Workspace Layout

cyspbot is a pnpm workspace with deployable Cloudflare Worker packages under `workers/*` and shared implementation packages under `packages/*`.

Deployable Workers:

- `workers/cyspbot-token-exchange` publishes package `@cyspbot/token-exchange` and Worker `cyspbot-token-exchange`.
- `workers/cyspbot-github-webhook-receiver` publishes package `@cyspbot/github-webhook-receiver` and Worker `cyspbot-github-webhook-receiver`.

Shared packages:

- `packages/http` owns framework-free JSON responses, problem details, and bounded byte-stream and request-body reading.
- `packages/github` owns GitHub App JWT signing, GitHub REST calls, installation lookup, installation access token creation, and secret binding resolution.
- `packages/oidc` owns OIDC Provider Registration validation, standards-derived OpenID Provider Configuration discovery, bounded OpenID Provider Metadata and JWK Set caches, and ID Token authentication.
- `packages/oidc-provider-fly` owns Fly organization-specific OIDC Provider Registration construction with an explicit null OIDC ID Token Profile.
- `packages/oidc-provider-github-actions` owns the GitHub Actions OIDC Provider Registration and OIDC ID Token Profile.
- `packages/oidc-provider-google-service-account` owns the Google service-account OIDC Provider Registration and OIDC ID Token Profile.

The root `wrangler.jsonc` points at `test/support/root-test-harness.ts`. It is a local/test binding harness, not a deployable product Worker.

## Token Exchange Worker

`@cyspbot/token-exchange` exposes a single route:

- `POST /token`

The Worker factory is `createTokenExchangeWorker` in `workers/cyspbot-token-exchange/src/worker.ts`. It constructs a request-scoped `TokenExchangeRequestRuntime` from Worker bindings and infrastructure dependencies, then passes that narrow runtime to the request handler. The Worker owns route and method dispatch; the [service contract](service-contract.md#public-endpoints) owns the observable routing behaviour.

`handleTokenExchangeRequest` in `workers/cyspbot-token-exchange/src/token-exchange.ts` implements the request flow without direct access to Cloudflare bindings. The runtime supplies rate limiting, ID Token authentication, installation-access-token issuance, and the current time:

1. Apply the rate-limit binding before reading or parsing the request body.
2. Perform bounded form-body reading and validate the token-exchange fields according to the [Token Exchange contract](service-contract.md#request-and-response-behaviour).
3. Normalize an `InstallationAccessTokenRequest` before subject-token authentication.
4. Select the preconfigured OIDC Provider Registration named by the token's unverified `iss` lookup value, obtain and validate its remote metadata and JWK Set, centrally verify the token, and apply its non-null OIDC ID Token Profile.
5. Retain the verified issuer and Subject Token Claims as the Verified Subject Token, with verification evidence kept separately for audit logging.
6. Evaluate Token Issuance Policy over `{ verifiedSubjectToken, tokenRequest }`.
7. Resolve the target GitHub App installation, verify its account owner against the normalized Repository Resource, and mint a token narrowed to that repository and the Requested Permissions.

`workers/cyspbot-token-exchange/src/installation-access-token-request.ts` performs issuer-independent request normalization, canonical Repository Resource construction, permission-map canonicalization, and permission-level union and coverage. `workers/cyspbot-token-exchange/src/policy/token-issuance-policy.ts` defensively compiles independently complete Permit Statements into an opaque immutable policy. Evaluation scans applicable statements and returns whether their composed Effective Permissions cover the Requested Permissions; separate support queries classify a failed authorization without granting one. `configured-token-issuance-policy.ts` owns the checked-in policy composition, while the [service contract](service-contract.md#token-issuance-policy) owns its current externally observable inventory. At composition time, every policy issuer must name a configured OIDC Provider Registration.

### Policy authoring and compilation

The policy module exports plain definition types and the `claimEquals`,
`claimOneOf`, `oidcSubjectTokenConstraint`, and
`githubRepositoryResourceConstraint` factories. A `PermitStatementDefinition`
combines one OIDC Subject Token Constraint, one Repository Resource Constraint, and non-empty
permissions. `compileTokenIssuancePolicy` is the construction seam: it rejects
unknown or inherited definition fields, invalid runtime values, duplicate Claim
Names within one subject-token constraint, empty or duplicate `claimOneOf`
alternatives, noncanonical repository components, malformed permission names,
and levels outside `read`, `write`, and `admin`.
It copies and recursively freezes owned values and exposes only an opaque
`TokenIssuancePolicy`.

The current evaluator scans statements in source order while tracking entries
in the Requested Permissions that remain uncovered. Exact resource and issuer
comparisons happen before Claim Predicates, and evaluation returns early once
the Requested Permissions are covered. This is equivalent to materializing
Effective Permissions because Permit Statements can add but never revoke
permissions.
The opaque policy interface permits changing this algorithm without changing
policy authoring or evaluation semantics. Tests exhaustively cover the complete
permission-level algebra with representative arbitrary names, plus statement
order, duplicates, split and merged definitions, and multi-statement
composition.

### Shared request normalization

The normalization module consumes the parsed `resource` and `scope` values and returns a canonical immutable `InstallationAccessTokenRequest`. Resource parsing, scope defaulting, permission syntax, duplicate handling, and response-visible canonicalization follow the [service contract](service-contract.md#request-and-response-behaviour); the implementation does not infer a target from Subject Token Claims.

### Policy composition

`configured-token-issuance-policy.ts` constructs the application policy from complete Permit Statement definitions. The Worker composition asserts that every issuer referenced by those statements has an OIDC Provider Registration. Issuer registration and authorization remain separate data structures; the [service contract](service-contract.md#supported-oidc-provider-registrations) owns the current registration inventory and [Token Issuance Policy section](service-contract.md#token-issuance-policy) owns the current authorization inventory.

### Shared enforcement and issuance

ID Token verification and any non-null OIDC ID Token Profile authenticate the Subject Token Claims, while each Token Issuance Policy Permit Statement decides which Claims matter to authorization. Missing or incorrectly typed selected Claims make statements non-applicable. The policy's target- and Requested-Permissions support queries classify a failed policy evaluation for the HTTP layer; the [service contract](service-contract.md#request-and-response-behaviour) owns the resulting responses.

`issueInstallationAccessTokenForContext` in `workers/cyspbot-token-exchange/src/policy/installation-access-token-issuance.ts` does not fetch source repository metadata or reparse the resource. It uses the owner and repository retained by request normalization, resolves the target installation with `GET /repos/{owner}/{repo}/installation`, verifies the returned installation account owner against the requested owner, and only then passes `repositories: ["<repo>"]` and the Requested Permissions to GitHub's installation-access-token endpoint. A mismatched owner is rejected before token minting so a repository-transfer redirect cannot cross the policy-authorized owner boundary.

Policy observability records only `token_issuance_policy.permitted`. Surrounding
request logs retain the verified issuer and Subject, OIDC verification evidence,
normalized Repository Resource, permissions, and scope, but never the complete
Subject Token Claims object. Policy logs contain no statement identifier,
contributor list, or denial-reason synthesis. A downstream GitHub failure after
authorization therefore retains `permitted: true`.

The issuance boundary classifies local configuration, GitHub API, transport,
rate-limit, and response-validation failures into internal issuance reasons.
Successful response bodies are validated against the schema required by each
GitHub operation. The [service contract](service-contract.md#request-and-response-behaviour)
owns the complete observable mapping; the [GitHub API Failure Classification
decision](decisions/github-api-failure-classification.md) owns its rationale.

GitHub `429` responses are rate limited directly. For a `403`, the shared
GitHub HTTP client checks `x-ratelimit-remaining: 0`, the presence of
`retry-after`, or a JSON error body's string `message` containing `rate limit`.
Error-body reads are limited to `16 KiB`; an absent, oversized, unreadable,
malformed, or differently shaped body contributes no rate-limit evidence.

The form parser removes value-less occurrences before enforcing singleton fields, and the scope parser constructs a canonical permission map without a vendor permission-name catalogue. The normalizer always supplies a non-empty explicit permission map to GitHub rather than relying on GitHub's installation defaults.

`workers/cyspbot-token-exchange/src/token-exchange-application.ts` groups one GitHub App credential set with its validated Token Issuance Policy. The request runtime constructs this explicit application configuration before issuance; issuance has no optional policy dependency or hidden fallback.

## ID Token Verification

`packages/oidc/src/id-token-authenticator.ts` exposes the deep `OidcIdTokenAuthenticator` authentication seam. An `OidcIdTokenAuthenticationTrust` contains one service-level `subjectTokenAudience` and exact `OidcProviderRegistration` records. Each registration contains a case-sensitive Issuer Identifier, its own accepted ID Token signing-algorithm allowlist, and either a code-owned OIDC ID Token Profile or explicit `null`. Omission is invalid. A registration deliberately does not contain an audience, JWK Set URI, authorization rule, or claim mapping.

The audience is service-level because all accepted subject tokens have one recipient: cyspbot's token-exchange service. The authenticator enforces the configured scalar audience during central ID Token validation. Provider registrations answer which authorities and token kinds cyspbot trusts; duplicating the same recipient policy into every provider would permit configuration drift without expressing a real provider property. In contrast, signing algorithms remain per provider because provider capabilities and local trust decisions can differ. Changing one provider's accepted algorithms cannot silently widen another provider.

The authenticator decodes an unverified issuer solely as a lookup key into its preconfigured registration map. An unknown issuer is rejected before OpenID Provider Configuration or JWK Set I/O. Its metadata boundary deliberately validates only the members this authenticator consumes: an `issuer` value exactly equal to the registered string, an HTTPS `jwks_uri`, and a non-empty `id_token_signing_alg_values_supported` array containing `RS256`. It accepts unconsumed standard metadata and provider extensions without attempting complete OpenID Provider Configuration validation. The token's protected-header algorithm must be present in both the local provider allowlist and the advertised signing algorithms. The discovered JWK Set location supplies keys only; it cannot add an issuer, audience, algorithm, profile, or authorization grant.

This module performs static, code-owned workload identity federation through ordinary OpenID Connect Discovery and ID Token validation. It does not implement OpenID Federation 1.0 Entity Statements, Trust Anchors, or Trust Chain resolution; `OidcIdTokenAuthenticator` avoids implying that protocol.

### Provider Configuration URL derivation

`deriveOidcProviderConfigurationUrl` follows OpenID Connect Discovery 1.0 section 4.1: remove a terminating slash from the exact Issuer Identifier for the request construction, then append `/.well-known/openid-configuration` after the issuer path. Consequently:

| Issuer Identifier               | Provider Configuration URL                                       |
| ------------------------------- | ---------------------------------------------------------------- |
| `https://issuer.example`        | `https://issuer.example/.well-known/openid-configuration`        |
| `https://issuer.example/tenant` | `https://issuer.example/tenant/.well-known/openid-configuration` |

The implementation does not use root-relative URL resolution, which would discard `/tenant`, and does not use RFC 8414's different insertion-before-path authorization-server metadata algorithm. It also has no fallback between the two algorithms. The original registered issuer string remains the value used for exact metadata and token `iss` comparison; URL construction never normalizes the trust identity.

### Provider registration composition

Provider packages construct exact `OidcProviderRegistration` values and own their OIDC ID Token Profile adapters. `configuredOidcProviderRegistrations` is an immutable, code-owned list with no Worker binding for dynamic issuer additions. Merely having a provider package in the workspace does not register it; the application composition must include it explicitly. The [service contract](service-contract.md#supported-oidc-provider-registrations) owns the current registrations and their client-visible token requirements.

### Cache and failure behavior

OpenID Provider Configuration and JWK Set requests never follow redirects: the derived or metadata-validated HTTPS URL is the only requested URL. Their responses must have status `200`, contain valid UTF-8 JSON, and be no larger than `64 KiB` and `256 KiB`, respectively. OpenID Provider Configuration requires `application/json`; a JWK Set also accepts the registered `application/jwk-set+json` media type. The required OpenID Provider Metadata is cached only after validation, together with the immutable intersection of provider-local and advertised signing algorithms used by every later verification and JWK Set resolution decision. A JWK Set contains at most 200 keys and must contain at least one public verification key usable with that intersection. Provider requests time out after five seconds. `Cache-Control: max-age` is honored up to one hour, with a five-minute default; `no-store`, `no-cache`, and `must-revalidate` constrain retention, immediate reuse, and stale use respectively. A validated last-known-good Provider Metadata generation can be used for at most one additional hour only after a Provider Configuration transport, body-stream, or non-200 failure; a successful response with an invalid representation or consumed metadata is never stale and rejects the subject token. JWK Set stale handling remains available for its existing provider-unavailability failures. Invalid refresh results never replace a good cached generation. Concurrent refreshes are coalesced only when both the exact discovered `jwks_uri` and the canonical accepted-algorithm intersection agree; a change to either creates a new key-set generation.

An unknown `kid` can trigger one JWK Set refresh after a ten-second cooldown. OpenID Provider Configuration failures have a ten-second per-provider backoff. JWK Set failures have a ten-second backoff for the exact JWK Set URI and accepted signing-algorithm intersection, so a failure cannot suppress retrieval for a new key-resolution generation. If a valid refreshed JWK Set still has no matching key, the token is rejected; a Client-presented `kid` is not evidence that the provider is unavailable. Structured events report OpenID Provider Configuration refresh, metadata generation, cache freshness and stale limits, selected JWK Set hosts, OIDC remote-document refresh failure, stale-document use, suppressed key refreshes, and `jwks_uri` changes.

Failures cross the authenticator interface as:

- `subject_token_rejected`: malformed JWT/JWS, invalid signature or claims, unregistered issuer, incompatible token algorithm, an invalid or nonconformant successful Provider Configuration response or consumed metadata, failed OIDC ID Token Profile, or no matching key.
- `provider_unavailable`: Provider Configuration network, timeout, body-stream, or HTTP failures, plus existing JWK Set network, timeout, HTTP, representation, shape, or provider-key failures when no applicable bounded last-known-good document is usable.
- `internal_failure`: unexpected internal authentication behavior.

The Token Exchange Worker translates these internal reasons according to the [service contract](service-contract.md#request-and-response-behaviour).

## Webhook Receiver Worker

`@cyspbot/github-webhook-receiver` exposes a single route:

- `POST /github/webhooks`

The Worker factory is `createGitHubWebhookReceiverWorker` in `workers/cyspbot-github-webhook-receiver/src/worker.ts`. It owns route and method dispatch; the [service contract](service-contract.md#github-webhook-receiver) owns the observable responses.

The Worker factory also owns the default runtime clock and accepts `GitHubWebhookReceiverDependencies` for test injection. The dependency interface lives with its consumer in `workers/cyspbot-github-webhook-receiver/src/github-webhooks/acceptance.ts`.

`acceptGitHubWebhookDelivery` in `workers/cyspbot-github-webhook-receiver/src/github-webhooks/acceptance.ts` implements the delivery flow:

1. Resolve `GITHUB_WEBHOOK_SECRET`.
2. Validate the media type and read the bounded request body according to the service contract.
3. Retain the exact request bytes for signature verification.
4. Require GitHub event, delivery, and signature headers.
5. Require target type `integration` and target id equal to `GITHUB_APP_ID`; missing target headers are treated as target-authentication failures.
6. Verify `X-Hub-Signature-256` against the exact request bytes.
7. Parse the authenticated body as JSON.
8. Construct an acknowledgement without product-specific event processing.

The receiver logs rejected delivery metadata but does not store raw bodies or parsed event payloads.

## Configuration

The source Worker configs declare placeholder values and binding names only.

Token exchange Worker bindings:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_API_BASE_URL`, defaulting to `https://api.github.com`
- `TOKEN_EXCHANGE_RATE_LIMIT`

Webhook receiver Worker bindings:

- `GITHUB_APP_ID`
- `GITHUB_WEBHOOK_SECRET`

Production deployment is handled outside this codebase.

## Verification Commands

The repository check path is:

```bash
node --run check
```

That command validates the lockfile, formatting, generated Env type freshness, type-checking against each Worker's runtime types, lint, Knip, Vitest, and Wrangler deploy dry runs.

Each Worker package owns its Env type generation, runtime type generation, type-check, and Wrangler deploy dry-run commands. The root scripts aggregate those package interfaces with the shared-package and test/tooling TypeScript projects.

The small `env.generated.d.ts` files are checked in because the combined test project consumes both generated environment interfaces without including either Worker's runtime types. Each Worker type-check generates its ignored `runtime.generated.d.ts` from that Worker's Wrangler compatibility date and flags immediately before invoking TypeScript. Runtime types are reproducible build artifacts rather than reviewable source.

The public GitHub Actions `ci` workflow runs the same classes of checks as separate reusable jobs and gates on an aggregate `ci` job.

`test/support/token-exchange-oidc-node-fixture.ts` is the intentional Node-only test seam
between this source repository and the separate deployment repository. It owns one
process-random key pair, the deterministic OpenID Provider Configuration and JWK Set
outbound adapter, Fly discovery and JWK Set integration cases, and the GitHub Actions
fixture request builder and expected outbound URLs. Vitest configuration consumes the same seam.
The token-exchange Workerd integration module receives the private key only through
`OIDC_TEST_PRIVATE_KEY` and does not import the Node key-generation module.

## External References

- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [OpenID Connect Core 1.0: ID Token validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
- [Fly.io OpenID Connect](https://fly.io/docs/security/openid-connect/)
- [Fly Machines API Tokens resource](https://fly.io/docs/machines/api/tokens-resource/)
- [GitHub Actions OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [GitHub Actions OIDC security hardening](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [Google Cloud authentication token types](https://cloud.google.com/docs/authentication/token-types#service_account_id_tokens)
- [Google IAM service account resource](https://cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts)
- [Google IAM Credentials `generateIdToken`](https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateIdToken)
- [Google IAM roles for service account authentication](https://cloud.google.com/iam/docs/service-account-permissions)
- [Google IAM delegated short-lived credentials](https://cloud.google.com/iam/docs/create-short-lived-credentials-delegated)
- [Google Cloud: Get an ID token](https://cloud.google.com/docs/authentication/get-id-token)
- [GitHub App installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Cloudflare Workers Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
