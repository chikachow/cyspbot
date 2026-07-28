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
- `packages/oidc-provider-fly` owns Fly organization-specific OIDC Provider Registration and OIDC ID Token Profile construction.
- `packages/oidc-provider-github-actions` owns the GitHub Actions OIDC Provider Registration and OIDC ID Token Profile.
- `packages/oidc-provider-google-service-account` owns the Google service-account OIDC Provider Registration and OIDC ID Token Profile.

The root `wrangler.jsonc` points at `test/support/root-test-harness.ts`. It is a local/test binding harness, not a deployable product Worker.

## Token Exchange Worker

`@cyspbot/token-exchange` exposes a single route:

- `POST /token`

The Worker factory is `createTokenExchangeWorker` in `workers/cyspbot-token-exchange/src/worker.ts`. It constructs a request-scoped `TokenExchangeRequestRuntime` from Worker bindings and infrastructure dependencies, then passes that narrow runtime to the request handler. Requests with any other path return problem-details `404`. Non-`POST` requests to `/token` return OAuth error JSON with `400 {"error":"invalid_request"}`.

`handleTokenExchangeRequest` in `workers/cyspbot-token-exchange/src/token-exchange.ts` implements the request flow without direct access to Cloudflare bindings. The runtime supplies rate limiting, ID Token authentication, installation-access-token issuance, and the current time:

1. Apply `TOKEN_EXCHANGE_RATE_LIMIT` before parsing the request body.
2. Require `application/x-www-form-urlencoded`.
3. Read at most `64 KiB`.
4. Require exactly one non-empty value for each required singleton token-exchange form parameter that cyspbot consumes; value-less instances are treated as omitted, and duplicated non-empty singleton parameters are malformed.
5. Require `subject_token_type=urn:ietf:params:oauth:token-type:id_token` and `requested_token_type=urn:chikachow:github-app-installation-access-token`; reject the generic JWT subject-token type.
6. Omit exactly empty `resource` occurrences, then require exactly one effective non-empty `resource`; treat an exactly empty optional `scope` as omitted.
7. Reject unsupported or ambiguous fields, including non-empty RFC 8693 `audience`, malformed or duplicate effective `scope`, actor-token fields, and multiple effective resources. Non-empty `audience` and a missing, malformed, or multiple effective `resource` map to `invalid_target`; actor-token parameters map to `invalid_request`.
8. Normalize an `InstallationAccessTokenRequest` from the explicit `resource` and optional `scope` before subject-token authentication.
9. Select one exact OIDC Provider Registration from the token's unverified `iss` claim. Reject an unregistered issuer before provider I/O, fetch its OpenID Provider Configuration, validate and retain the required OpenID Provider Metadata, obtain the JWK Set from the validated `jwks_uri`, centrally verify the token, require the exact scalar subject-token audience `cyspbot`, and apply the provider's OIDC ID Token Profile.
10. Retain only verified claims and the verified issuer as the Verified Subject Token. Keep the resolved key ID separately as verification evidence for audit logging; neither it nor the request's already-validated token type is authorization identity.
11. Evaluate static Token Policy over `{ verifiedSubjectToken, tokenRequest }`.
12. Resolve the target GitHub App installation from the normalized repository resource using cyspbot's configured GitHub App credentials.
13. Issue a GitHub App installation access token for `repositories: [<repo>]` and the normalized permissions.

`workers/cyspbot-token-exchange/src/installation-access-token-request.ts` performs issuer-independent normalization from an explicit `resource` and optional `scope`, including canonical repository-resource parsing. The normalized resource retains its canonical URI, owner, and repository so downstream issuance cannot reinterpret it. It does not inspect subject-token identity and can therefore run before authentication. The token policy in `workers/cyspbot-token-exchange/src/policy/token-policy.ts` structurally authorizes the verified issuer, repository resource, and permission set. `workers/cyspbot-token-exchange/src/policy/token-policy-condition.ts` uses the CEL library to compile, cache, bind, and evaluate conditions over signed `claims` only; request fields, issuer, key ID, and token type are not CEL bindings. CEL errors, absent or unknown claims, type mismatches, and non-boolean results fail closed. Provider rule builders in `workers/cyspbot-token-exchange/src/policy/` own reusable issuer-specific claim conditions for policy definitions and tests. Policy does not mutate the requested token shape. At composition time, every policy issuer must name a configured OIDC Provider Registration, preventing unreachable or accidentally unverified issuer grants. Exact policy entries are service-owned authorization data rather than implementation documentation; the provider-specific behavior documented here is written as the steady-state contract and does not change merely because policy entries move or are deployed later.

cyspbot does not accept a public GitHub App selector. It constrains this profile to cyspbot's configured GitHub App credentials, one signed subject-token `aud` string equal to `cyspbot`, one canonical GitHub repository API `resource`, and one normalized permission set. Plural subject-token audiences are rejected rather than interpreted by containment.

### Shared request normalization

An omitted `scope` normalizes to a PR-authoring permission request.

```json
{
  "contents": "write",
  "pull_requests": "write"
}
```

Every Installation Access Token Request requires an explicit Repository Resource, regardless of OIDC Provider Registration; subject-token claims never select the target.

### Provider-specific Token Policy

#### Fly.io

Fly Clients must supply an explicit repository `resource`; cyspbot does not derive a GitHub repository target from Fly claims. `flyMachineInstallationAccessTokenRule` builds an issuer-guarded condition that selects the provider-assigned organization and Fly App IDs and can optionally select one stable Machine ID. Its canonical repository resource and permissions must also match exactly. Authentication alone creates no grant.

#### GitHub Actions

GitHub Actions Clients must supply an explicit repository `resource`. The token request is allowed only when an issuer-guarded rule's CEL condition matches the signed GitHub Actions `repository`, event, `ref`, `sub`, and exact `workflow_ref` claims and the rule's canonical resource URI and permissions match the normalized request. The signed `repository` claim is subject identity available to policy, not an implicit target selector. The condition accepts the expected legacy GitHub subject or its immutable owner/repository-ID form; inconsistent names or IDs therefore do not match. Rule order is not semantically meaningful; authorization is `allow` if any rule matches and `deny` otherwise. Exact policy entries are intentionally not documented here because they may move to live configuration.

Repository identity in Token Policy is intentionally name-based. GitHub Actions OIDC exposes `repository_id` and `repository_owner_id` as signed claims, immutable subject formats can include those IDs in `sub`, and GitHub's installation-access-token API supports `repository_ids`; cyspbot still chooses owner/repository names as the policy identifier because they are the maintained external resource names and because token issuance still requires the configured GitHub App installation to cover that repository name. Legacy subjects therefore do not require ID claims. Immutable subjects require `repository_id` to agree with `sub`; the optional `repository_owner_id` claim is checked only when present and non-null. These IDs reject internal inconsistencies but are not independent policy keys. If a repository is deleted and recreated with the same owner/name, matching existing policy for that name is accepted behavior rather than a bypass. GitHub subject strings are compared literally rather than percent-decoding repository or ref components.

#### Google service account ID Tokens

Google service account Clients must supply an explicit repository `resource`; cyspbot does not derive a GitHub repository target from Google claims. `googleServiceAccountInstallationAccessTokenRule` builds an issuer-guarded condition that compares the service account unique ID as an opaque string. It can additionally require an exact signed email with `email_verified == true`. Its canonical repository resource and permissions must also match exactly. Authentication alone creates no grant.

### Shared enforcement and issuance

ID Token verification and OIDC ID Token Profile validation authenticate the signed claim set, while Token Policy decides which claims matter for a particular grant. Missing or incorrectly typed claims named by a condition fail closed as `invalid_target`; policy-irrelevant metadata does not affect authorization. An invalid standard ID Token claim or failed OIDC ID Token Profile validation causes authentication to fail as `invalid_request`.

`issueInstallationAccessTokenForContext` in `workers/cyspbot-token-exchange/src/policy/installation-access-token-issuance.ts` does not fetch source repository metadata or reparse the resource. It uses the owner and repository retained by request normalization, resolves the target installation with `GET /repos/{owner}/{repo}/installation`, then passes `repositories: ["<repo>"]` and the normalized permissions to GitHub's installation-access-token endpoint.

cyspbot treats exactly empty `scope` and `resource` form occurrences as omitted. It requires exactly one remaining resource, so empty-only resources and multiple non-empty resources receive `invalid_target`; one non-empty resource accompanied by empty occurrences remains unambiguous. It does not translate `scope=` into `permissions: {}`. GitHub documents that omitting `permissions` defaults to the app installation's granted permissions, and live testing showed that a present empty `permissions: {}` object receives the same default permission set. Minimal-permission token shapes must be expressed as explicit non-empty scopes such as `contents:read`. Scope values are parsed as OAuth scope tokens separated by a single ASCII space; order is not significant, and repeated identical tokens are normalized once. Leading whitespace, trailing whitespace, repeated spaces, tabs, and newlines are rejected. The normalized token request retains a canonical scope string, and `/token` success responses always include that issued scope so clients can observe defaults and normalized ordering.

`workers/cyspbot-token-exchange/src/token-exchange-application.ts` groups one GitHub App credential set with its already validated Token Policy. The request runtime constructs this explicit application configuration before issuance; issuance has no optional policy dependency or hidden fallback. Future path-based application selection can therefore choose among application configurations without changing request normalization or policy evaluation.

cyspbot does not support OAuth client authentication at `/token`. Non-empty `client_id`, `client_secret`, `client_assertion`, and `client_assertion_type` form parameters are rejected with `invalid_request` so Clients cannot mistakenly believe client credentials affected token issuance. Value-less form parameters are treated as omitted. An `Authorization` header is rejected with `invalid_client` and `401` before body parsing. Non-empty `authorization_details` is also rejected because this profile expresses the token shape only through cyspbot's service app, `resource`, and `scope`.

## ID Token Verification

`packages/oidc/src/id-token-authenticator.ts` exposes the deep `OidcIdTokenAuthenticator` authentication seam. An `OidcIdTokenAuthenticationTrust` contains one service-level `subjectTokenAudience` and exact `OidcProviderRegistration` records. Each registration contains only a case-sensitive Issuer Identifier, its own accepted ID Token signing-algorithm allowlist, and a code-owned OIDC ID Token Profile. A registration deliberately does not contain an audience, JWK Set URI, authorization rule, or claim mapping.

The audience is service-level because all accepted subject tokens have one recipient: cyspbot's token-exchange service. It is enforced during central ID Token validation as the exact scalar `aud` value `cyspbot`. Provider registrations answer which authorities and token kinds cyspbot trusts; duplicating the same recipient policy into every provider would permit configuration drift without expressing a real provider property. In contrast, signing algorithms remain per provider because provider capabilities and local trust decisions can differ. Changing one provider's accepted algorithms cannot silently widen another provider.

The authenticator decodes an unverified issuer solely as a lookup key into its preconfigured registration map. An unknown issuer is rejected before OpenID Provider Configuration or JWK Set I/O. The validated OpenID Provider Metadata must contain an `issuer` value exactly equal to the registered string and an HTTPS `jwks_uri`. The token's protected-header algorithm must be present in both the local provider allowlist and `id_token_signing_alg_values_supported`. The discovered JWK Set location supplies keys only; it cannot add an issuer, audience, algorithm, profile, or authorization grant.

This module performs static, code-owned workload identity federation through ordinary OpenID Connect Discovery and ID Token validation. It does not implement OpenID Federation 1.0 Entity Statements, Trust Anchors, or Trust Chain resolution; `OidcIdTokenAuthenticator` avoids implying that protocol.

### Provider Configuration URL derivation

`deriveOidcProviderConfigurationUrl` follows OpenID Connect Discovery 1.0 section 4.1: remove a terminating slash from the exact Issuer Identifier for the request construction, then append `/.well-known/openid-configuration` after the issuer path. Consequently:

| Issuer Identifier               | Provider Configuration URL                                       |
| ------------------------------- | ---------------------------------------------------------------- |
| `https://issuer.example`        | `https://issuer.example/.well-known/openid-configuration`        |
| `https://issuer.example/tenant` | `https://issuer.example/tenant/.well-known/openid-configuration` |

The implementation does not use root-relative URL resolution, which would discard `/tenant`, and does not use RFC 8414's different insertion-before-path authorization-server metadata algorithm. It also has no fallback between the two algorithms. The original registered issuer string remains the value used for exact metadata and token `iss` comparison; URL construction never normalizes the trust identity.

### Supported OIDC Provider Registrations

| Provider                         | Issuer Identifier (`iss`)                     | Local algorithm allowlist | OIDC ID Token Profile                                             |
| -------------------------------- | --------------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| Fly                              | `https://oidc.fly.io/{org-slug}`              | `RS256`                   | binds `org_name`, `app_name`, `machine_name`, and canonical `sub` |
| GitHub Actions                   | `https://token.actions.githubusercontent.com` | `RS256`                   | absent `azp`, or `azp == aud`                                     |
| Google service-account ID Tokens | `https://accounts.google.com`                 | `RS256`                   | `azp == sub`                                                      |

#### Fly.io

The integration Worker parses `FLY_OIDC_ORG_SLUGS` as comma-delimited Fly Organization Slugs. An absent or exactly empty binding creates no Fly registration. Otherwise every trimmed entry must be non-empty, unique, and canonical lowercase alphanumeric/hyphen syntax without a leading or trailing hyphen. Any bad entry rejects the entire configuration; cyspbot never begins serving with an unintended partial trust set. Each accepted slug creates one exact provider registration. The immutable registration list and authenticator are cached by the raw binding and dependency identities.

After shared ID Token verification, the Fly OIDC ID Token Profile requires the signed `org_name`, `app_name`, and `machine_name` values used by Fly's canonical Subject. It requires `org_name` to equal the organization slug in the verified Issuer Identifier and `sub` to equal `{org_name}:{app_name}:{machine_name}`. Other signed claims, including `org_id`, `app_id`, `machine_id`, `machine_version`, and `nbf`, do not participate in authentication. Token Policy can select any of those claims when they matter to a grant. The profile does not assign Fly-specific meaning to `azp`.

#### GitHub Actions

Central verification requires the standard ID Token claims. The GitHub Actions OIDC ID Token Profile additionally accepts an absent Authorized Party (`azp`) claim and requires it to equal the already-verified `aud` when present.

#### Google service account ID Tokens

The Google service-account registration accepts only the Google Cloud IAM authorization server's Issuer Identifier `https://accounts.google.com` and locally allows `RS256`. After shared ID Token verification has established a non-empty string Subject (`sub`), its profile requires the Authorized Party (`azp`) to equal that Subject. Google documents both claims as the service account unique ID for this token type. cyspbot treats that identifier as an opaque string. This excludes Google user ID Tokens, whose Authorized Party is an OAuth client ID, while the configured Issuer Identifier excludes self-signed service-account JWTs, whose Issuer is the service account. Email claims are not required for authentication; a policy rule that selects an email also requires the signed `email_verified` claim to be `true`.

### Cache and failure behavior

OpenID Provider Configuration and JWK Set requests never follow redirects: the derived or metadata-validated HTTPS URL is the only requested URL. Their responses must have status `200`, contain valid UTF-8 JSON, and be no larger than `64 KiB` and `256 KiB`, respectively. OpenID Provider Configuration requires `application/json`; a JWK Set also accepts the registered `application/jwk-set+json` media type. The required OpenID Provider Metadata is cached only after validation, together with the immutable intersection of provider-local and advertised signing algorithms used by every later verification and JWK Set resolution decision. A JWK Set contains at most 200 keys and must contain at least one public verification key usable with that intersection. Provider requests time out after five seconds. `Cache-Control: max-age` is honored up to one hour, with a five-minute default; `no-store`, `no-cache`, and `must-revalidate` constrain retention, immediate reuse, and stale use respectively. Otherwise, a validated last-known-good OpenID Provider Metadata or JWK Set generation can be used for at most one additional hour when refresh fails. Invalid refresh results never replace a good cached generation. Concurrent refreshes are coalesced only when both the exact discovered `jwks_uri` and the canonical accepted-algorithm intersection agree; a change to either creates a new key-set generation.

An unknown `kid` can trigger one JWK Set refresh after a ten-second cooldown. OpenID Provider Configuration failures have a ten-second per-provider backoff. JWK Set failures have a ten-second backoff for the exact JWK Set URI and accepted signing-algorithm intersection, so a failure cannot suppress retrieval for a new key-resolution generation. If a valid refreshed JWK Set still has no matching key, the token is rejected; a Client-presented `kid` is not evidence that the provider is unavailable. Structured events report OpenID Provider Configuration refresh, metadata generation, cache freshness and stale limits, selected JWK Set hosts, OIDC remote-document refresh failure, stale-document use, suppressed key refreshes, and `jwks_uri` changes.

Failures cross the authenticator interface as:

- `subject_token_rejected`: malformed JWT/JWS, invalid signature or claims, unregistered issuer, incompatible token algorithm, failed OIDC ID Token Profile, or no matching key. `/token` returns `400 {"error":"invalid_request"}`.
- `provider_unavailable`: OpenID Provider Configuration or JWK Set network, timeout, HTTP, content, shape, or provider-key failures when no bounded last-known-good OpenID Provider Metadata or JWK Set is usable. `/token` returns `503 {"error":"temporarily_unavailable"}`.
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

- `FLY_OIDC_ORG_SLUGS`, a comma-delimited allow-list of Fly Organization Slugs; any empty, duplicate, or unsupported entry in a non-empty binding rejects the complete configuration
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
outbound adapter, the fixture Fly registration string, and the GitHub Actions fixture
request builder and expected outbound URLs. Vitest configuration consumes the same seam.
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
