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

The Worker factory is `createTokenExchangeWorker` in `workers/cyspbot-token-exchange/src/worker.ts`; the package root exports that factory beside the default Worker. At Worker construction it validates the configured issuer/policy relationship and builds one OIDC ID Token Authenticator, retaining its remote-document and JWK Set caches for the Worker lifetime. Each `/token` request supplies only its Worker bindings, rate-limit decision, and clock to the endpoint handler. Requests with any other path return problem-details `404`. Non-`POST` requests to `/token` return OAuth error JSON with `400 {"error":"invalid_request"}`.

`handleTokenExchangeRequest` in `workers/cyspbot-token-exchange/src/token-exchange.ts` implements the HTTP flow without direct access to Cloudflare bindings. Its private exchange operation owns the security-critical sequence: OIDC authentication, Token Issuance Policy evaluation, and GitHub installation access-token issuance. The endpoint adapter supplies rate limiting and the current time:

1. Apply `TOKEN_EXCHANGE_RATE_LIMIT` before parsing the request body.
2. Require `application/x-www-form-urlencoded`.
3. Read at most `64 KiB`.
4. Require exactly one non-empty value for each required singleton token-exchange form parameter that cyspbot consumes; value-less instances are treated as omitted, and duplicated non-empty singleton parameters are malformed.
5. Require `subject_token_type=urn:ietf:params:oauth:token-type:id_token` and `requested_token_type=urn:chikachow:github-app-installation-access-token`; reject the generic JWT subject-token type.
6. Omit exactly empty `resource` occurrences, then require exactly one effective non-empty `resource`; treat an exactly empty optional `scope` as omitted.
7. Reject unsupported or ambiguous fields, including non-empty RFC 8693 `audience`, malformed or duplicate effective `scope`, actor-token fields, and multiple effective resources. Non-empty `audience` and a missing, malformed, or multiple effective `resource` map to `invalid_target`; actor-token parameters map to `invalid_request`.
8. Normalize an `InstallationAccessTokenRequest` from the explicit `resource` and optional `scope` before subject-token authentication.
9. Select one exact OIDC Provider Registration from the token's unverified `iss` claim. Reject an unregistered issuer before provider I/O, fetch its OpenID Provider Configuration, validate and retain the required OpenID Provider Metadata, obtain the JWK Set from the validated `jwks_uri`, centrally verify the token, require the exact scalar subject-token audience `cyspbot`, and apply the provider's OIDC ID Token Profile only when it is non-null.
10. Retain only the Subject Token Claims and verified issuer as the Verified Subject Token. Keep the resolved key ID separately as verification evidence for audit logging; neither it nor the request's already-validated token type is authorization identity.
11. Evaluate the static Token Issuance Policy over `{ verifiedSubjectToken, tokenRequest }`.
12. Resolve the target GitHub App installation from the normalized Repository Resource using cyspbot's configured GitHub App credentials, and require the returned installation account owner to match the requested Repository Resource owner.
13. Issue a GitHub App installation access token for `repositories: [<repo>]` and the Requested Permissions.

`workers/cyspbot-token-exchange/src/installation-access-token-request.ts` performs issuer-independent normalization from an explicit `resource` and optional `scope`, including canonical repository-resource parsing. It accepts structurally valid permission names without a vendor catalogue, owns the closed `read`, `write`, and `admin` level set, and constructs canonical immutable Requested Permissions maps. It also owns pointwise coverage and union plus the closed Repository Resource constructor. `workers/cyspbot-token-exchange/src/policy/token-issuance-policy.ts` defensively compiles independently complete Permit Statements into an opaque immutable policy. Each statement has an exact issuer, Claim Predicates over Subject Token Claims, one exact Repository Resource Constraint, and non-empty permissions. Evaluation finds all applicable statements, computes their pointwise permission union using `omitted < read < write < admin`, and returns one Boolean indicating whether the Effective Permissions cover the Requested Permissions. Missing or wrongly typed Claims make predicates false. Separate Boolean target- and Requested-Permissions support queries classify RFC 8693 and OAuth errors after policy does not permit issuance; neither can authorize issuance. `configured-token-issuance-policy.ts` owns the nine production GitHub Actions statements. At composition time, every policy issuer must name a configured OIDC Provider Registration.

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

cyspbot does not accept a public GitHub App selector. It constrains this profile to cyspbot's configured GitHub App credentials, one signed subject-token `aud` string equal to `cyspbot`, one canonical GitHub repository API `resource`, and one Requested Permissions map. Plural subject-token audiences are rejected rather than interpreted by containment.

### Shared request normalization

An omitted `scope` normalizes to these PR-authoring Requested Permissions.

```json
{
  "contents": "write",
  "pull_requests": "write"
}
```

Every Installation Access Token Request requires an explicit Repository Resource, regardless of OIDC Provider Registration; Subject Token Claims never select the target.

### Configured Token Issuance Policy

The production policy contains nine GitHub Actions Permit Statements and no Fly or Google statement. Issuer registration and authorization remain independent: production registers GitHub Actions and Google, but only GitHub Actions has Permit Statements.

#### GitHub Actions

GitHub Actions Clients must supply an explicit repository `resource`. A statement predicate selects the signed `repository`, `event_name`, `ref_type`, `ref`, and `workflow_ref` Claims. It deliberately does not select `sub`, repository IDs, or owner IDs. The signed `repository` Claim is verified context in the Subject Token Claims available to policy, not an implicit target selector. Statement order is immaterial, and several applicable statements can jointly cover the Requested Permissions.

Repository identity in Token Issuance Policy is intentionally name-based. If a repository is deleted and recreated with the same owner/name, matching existing policy for that name is accepted behavior rather than a bypass; a GitHub App installation with sufficient repository access and permissions remains independently required.

### Shared enforcement and issuance

ID Token verification and any non-null OIDC ID Token Profile authenticate the Subject Token Claims, while each Token Issuance Policy Permit Statement decides which Claims matter to its authorization. Missing or incorrectly typed selected Claims make statements non-applicable; when the Repository Resource and Requested Permissions are otherwise supported, the Verified Subject Token is unacceptable to policy and cyspbot returns `invalid_request`. For an unsupported Repository Resource, cyspbot returns `invalid_target`; when no Permit Statement composition covers the Requested Permissions for a supported resource, it returns `invalid_scope`. Policy-irrelevant metadata does not affect authorization. An invalid standard ID Token Claim or failed non-null profile also causes authentication to fail as `invalid_request`.

The private installation-access-token exchange does not fetch source repository metadata or reparse the resource. After policy permits issuance, it uses the owner and repository retained by request normalization, resolves the target installation with `GET /repos/{owner}/{repo}/installation`, verifies the returned installation account owner against the requested owner, and only then passes `repositories: ["<repo>"]` and the Requested Permissions to GitHub's installation-access-token endpoint. A mismatched owner is rejected before token minting so a repository-transfer redirect cannot cross the policy-authorized owner boundary. Its internal failures remain stage-tagged as authentication, authorization, or issuance so the endpoint maps each existing OAuth response without making policy denial look like a GitHub failure.

Policy observability records only `token_issuance_policy.permitted`. Surrounding
request logs retain the verified issuer and Subject, OIDC verification evidence,
normalized Repository Resource, permissions, and scope, but never the complete
Subject Token Claims object. Policy logs contain no statement identifier,
contributor list, or denial-reason synthesis. A downstream GitHub failure after
authorization therefore retains `permitted: true`.

The issuance boundary does not infer an invalid OAuth target from an ambiguous
GitHub status. Missing or invalid local GitHub App private-key material and
GitHub 401 are treated as service-owned failures. GitHub 422 validation after
policy approval is also a service/configuration failure, rather than
`invalid_scope`. GitHub 403 and 404, and malformed, schema-invalid, or oversized
successful GitHub responses, are conservatively upstream failures; transport failures,
GitHub 503 responses, and 403 or 429 rate-limit responses are upstream
unavailability. Successful response bodies are validated against the schema
required by each GitHub operation and limited to `64 KiB`; an oversized body is
therefore an invalid upstream representation. Only policy's resource-support query produces
`target_unsupported`. The durable rationale and complete response mapping are
recorded in the [GitHub API Failure Classification decision](decisions/github-api-failure-classification.md).

The `server_error` and `temporarily_unavailable` Token Endpoint responses and
their `500`, `502`, and `503` statuses are explicit cyspbot protocol extensions,
not claims of compliance with RFC 6749 section 5.2. The service contract owns
the complete observable mapping; the decision record owns its rationale.

GitHub `429` responses are rate limited directly. For a `403`, the shared
GitHub HTTP client checks `x-ratelimit-remaining: 0`, the presence of
`retry-after`, or a JSON error body's string `message` containing `rate limit`.
Error-body reads are limited to `16 KiB`; an absent, oversized, unreadable,
malformed, or differently shaped body contributes no rate-limit evidence.

cyspbot treats exactly empty `scope` and `resource` form occurrences as omitted. It requires exactly one remaining resource, so empty-only resources and multiple non-empty resources receive `invalid_target`; one non-empty resource accompanied by empty occurrences remains unambiguous. It does not translate `scope=` into `permissions: {}`. GitHub documents that omitting `permissions` defaults to the app installation's granted permissions, and live testing showed that a present empty `permissions: {}` object receives the same default permission set. Minimal-permission token shapes must be expressed as explicit non-empty scopes such as `contents:read`.

Scope values are parsed as OAuth scope tokens separated by a single ASCII space. Each token contains one non-empty ASCII scope-token permission name, one colon, and a `read`, `write`, or `admin` level. The parser validates representation and safety rather than consulting a GitHub permission-name catalogue; GitHub owns name and level compatibility. Order is not significant, repeated identical tokens are normalized once, and conflicting levels for one name are rejected. Leading whitespace, trailing whitespace, repeated spaces, tabs, newlines, empty names, extra colons, non-scope-token characters, and other levels are rejected. The normalized Installation Access Token Request retains a canonical scope string, and `/token` success responses always include that issued scope so Clients can observe defaults and normalized ordering.

The exchange closes over the validated Token Issuance Policy and requires the GitHub App bindings supplied by the Worker for every issuance. It has no optional policy dependency, hidden fallback, public provider registry, or public GitHub adapter seam.

cyspbot does not support OAuth client authentication at `/token`. Non-empty `client_id`, `client_secret`, `client_assertion`, and `client_assertion_type` form parameters are rejected with `invalid_request` so Clients cannot mistakenly believe client credentials affected token issuance. Value-less form parameters are treated as omitted. An `Authorization` header is rejected with `invalid_client` and `401` before body parsing. Non-empty `authorization_details` is also rejected because this profile expresses the token shape only through cyspbot's service app, `resource`, and `scope`.

## ID Token Verification

`packages/oidc/src/id-token-authenticator.ts` exposes the deep `OidcIdTokenAuthenticator` authentication seam. An `OidcIdTokenAuthenticationTrust` contains one service-level `subjectTokenAudience` and exact `OidcProviderRegistration` records. Each registration contains a case-sensitive Issuer Identifier, its own accepted ID Token signing-algorithm allowlist, and either a code-owned OIDC ID Token Profile or explicit `null`. Omission is invalid. A registration deliberately does not contain an audience, JWK Set URI, authorization rule, or claim mapping.

The audience is service-level because all accepted subject tokens have one recipient: cyspbot's token-exchange service. It is enforced during central ID Token validation as the exact scalar `aud` value `cyspbot`. Provider registrations answer which authorities and token kinds cyspbot trusts; duplicating the same recipient policy into every provider would permit configuration drift without expressing a real provider property. In contrast, signing algorithms remain per provider because provider capabilities and local trust decisions can differ. Changing one provider's accepted algorithms cannot silently widen another provider.

The authenticator decodes an unverified issuer solely as a lookup key into its preconfigured registration map. An unknown issuer is rejected before OpenID Provider Configuration or JWK Set I/O. Its metadata boundary deliberately validates only the members this authenticator consumes: an `issuer` value exactly equal to the registered string, an HTTPS `jwks_uri`, and a non-empty `id_token_signing_alg_values_supported` array containing `RS256`. It accepts unconsumed standard metadata and provider extensions without attempting complete OpenID Provider Configuration validation. The token's protected-header algorithm must be present in both the local provider allowlist and the advertised signing algorithms. The discovered JWK Set location supplies keys only; it cannot add an issuer, audience, algorithm, profile, or authorization grant.

This module performs static, code-owned workload identity federation through ordinary OpenID Connect Discovery and ID Token validation. It does not implement OpenID Federation 1.0 Entity Statements, Trust Anchors, or Trust Chain resolution; `OidcIdTokenAuthenticator` avoids implying that protocol.

### Provider Configuration URL derivation

`deriveOidcProviderConfigurationUrl` follows OpenID Connect Discovery 1.0 section 4.1: remove a terminating slash from the exact Issuer Identifier for the request construction, then append `/.well-known/openid-configuration` after the issuer path. Consequently:

| Issuer Identifier               | Provider Configuration URL                                       |
| ------------------------------- | ---------------------------------------------------------------- |
| `https://issuer.example`        | `https://issuer.example/.well-known/openid-configuration`        |
| `https://issuer.example/tenant` | `https://issuer.example/tenant/.well-known/openid-configuration` |

The implementation does not use root-relative URL resolution, which would discard `/tenant`, and does not use RFC 8414's different insertion-before-path authorization-server metadata algorithm. It also has no fallback between the two algorithms. The original registered issuer string remains the value used for exact metadata and token `iss` comparison; URL construction never normalizes the trust identity.

### Supported OIDC Provider Registrations

| Provider                         | Issuer Identifier (`iss`)                     | Local algorithm allowlist | OIDC ID Token Profile         |
| -------------------------------- | --------------------------------------------- | ------------------------- | ----------------------------- |
| GitHub Actions                   | `https://token.actions.githubusercontent.com` | `RS256`                   | absent `azp`, or `azp == aud` |
| Google service-account ID Tokens | `https://accounts.google.com`                 | `RS256`                   | `azp == sub`                  |

The production registration list is the immutable `configuredOidcProviderRegistrations` array and contains exactly GitHub Actions and Google. It has no Worker binding or runtime path for adding issuers. The Fly provider package remains capable of constructing an exact organization-specific registration with an explicit null profile; production neither imports nor instantiates it.

#### GitHub Actions

Central verification requires the standard ID Token claims. The GitHub Actions OIDC ID Token Profile additionally accepts an absent Authorized Party (`azp`) claim and requires it to equal the already-verified `aud` when present.

#### Google service account ID Tokens

The Google service-account registration accepts only the Google Cloud IAM authorization server's Issuer Identifier `https://accounts.google.com` and locally allows `RS256`. After shared ID Token verification has established a non-empty string Subject (`sub`), its profile requires the Authorized Party (`azp`) to equal that Subject. Google documents both claims as the service account unique ID for this token type. cyspbot treats that identifier as an opaque string. This excludes Google user ID Tokens, whose Authorized Party is an OAuth client ID, while the configured Issuer Identifier excludes self-signed service-account JWTs, whose Issuer is the service account. Email claims are not required for authentication.

### Cache and failure behavior

OpenID Provider Configuration and JWK Set requests never follow redirects: the derived or metadata-validated HTTPS URL is the only requested URL. Their responses must have status `200`, contain valid UTF-8 JSON, and be no larger than `64 KiB` and `256 KiB`, respectively. OpenID Provider Configuration requires `application/json`; a JWK Set also accepts the registered `application/jwk-set+json` media type. The required OpenID Provider Metadata is cached only after validation, together with the immutable intersection of provider-local and advertised signing algorithms used by every later verification and JWK Set resolution decision. A JWK Set contains at most 200 keys and must contain at least one public verification key usable with that intersection. Provider requests time out after five seconds. `Cache-Control: max-age` is honored up to one hour, with a five-minute default; `no-store`, `no-cache`, and `must-revalidate` constrain retention, immediate reuse, and stale use respectively. A validated last-known-good Provider Metadata generation can be used for at most one additional hour only after a Provider Configuration transport, body-stream, or non-200 failure; a successful response with an invalid representation or consumed metadata is never stale and rejects the subject token. JWK Set stale handling remains available for its existing provider-unavailability failures. Invalid refresh results never replace a good cached generation. Concurrent refreshes are coalesced only when both the exact discovered `jwks_uri` and the canonical accepted-algorithm intersection agree; a change to either creates a new key-set generation.

An unknown `kid` can trigger one JWK Set refresh after a ten-second cooldown. OpenID Provider Configuration failures have a ten-second per-provider backoff. JWK Set failures have a ten-second backoff for the exact JWK Set URI and accepted signing-algorithm intersection, so a failure cannot suppress retrieval for a new key-resolution generation. If a valid refreshed JWK Set still has no matching key, the token is rejected; a Client-presented `kid` is not evidence that the provider is unavailable. Structured events report OpenID Provider Configuration refresh, metadata generation, cache freshness and stale limits, selected JWK Set hosts, OIDC remote-document refresh failure, stale-document use, suppressed key refreshes, and `jwks_uri` changes.

Failures cross the authenticator interface as:

- `subject_token_rejected`: malformed JWT/JWS, invalid signature or claims, unregistered issuer, incompatible token algorithm, an invalid or nonconformant successful Provider Configuration response or consumed metadata, failed OIDC ID Token Profile, or no matching key. `/token` returns `400 {"error":"invalid_request"}`.
- `provider_unavailable`: Provider Configuration network, timeout, body-stream, or HTTP failures, plus existing JWK Set network, timeout, HTTP, representation, shape, or provider-key failures when no applicable bounded last-known-good document is usable. `/token` returns `503 {"error":"temporarily_unavailable"}`.
- `internal_failure`: unexpected internal authentication behavior. `/token` returns `500 {"error":"server_error"}`.

## Webhook Receiver Worker

`@cyspbot/github-webhook-receiver` exposes a single route:

- `POST /github/webhooks`

The Worker factory is `createGitHubWebhookReceiverWorker` in `workers/cyspbot-github-webhook-receiver/src/worker.ts`. Requests with any other path return problem-details `404`. Non-`POST` requests to `/github/webhooks` return problem-details `405` with `Allow: POST`.

The Worker factory also owns the default runtime clock and accepts `GitHubWebhookReceiverDependencies` for test injection. The dependency interface lives with its consumer in `workers/cyspbot-github-webhook-receiver/src/github-webhooks/acceptance.ts`.

`acceptGitHubWebhookDelivery` in `workers/cyspbot-github-webhook-receiver/src/github-webhooks/acceptance.ts` implements the delivery flow:

1. Resolve `GITHUB_WEBHOOK_SECRET`.
2. Require `application/json`.
3. Read at most `256 KiB`.
4. Require GitHub event, delivery, and signature headers.
5. Require target type `integration` and target id equal to `GITHUB_APP_ID`; missing target headers are treated as target-authentication failures.
6. Verify `X-Hub-Signature-256` against the exact request bytes.
7. Parse the authenticated body as JSON.
8. Acknowledge signed `ping` deliveries with the event name; acknowledge all other valid signed JSON events without event-specific processing.

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
