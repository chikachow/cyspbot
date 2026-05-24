# Product Requirements Document: Cyspbot GitHub Actions Security Token Service

This document remains the primary contract document for the externally compatible Token Minting and webhook edge surface.

The Dashboard Session and persistence re-cut is now specified separately in [docs/dashboard-d1-recut.md](/Users/STalbot@Scentregroup.com/src/cysp/cyspbot/docs/dashboard-d1-recut.md). Where this document previously described Dashboard Session Durable Objects or installation-local Audit Log persistence as the durable target design, the D1-backed re-cut document supersedes those details.

## 1. Purpose

The service exists to let trusted GitHub Actions workflow runs obtain short-lived GitHub App installation access tokens without exposing the GitHub App private key to GitHub Actions runners or other caller-controlled environments.

The service must provide:

- HTTP routes, methods, and response shapes
- Authentication and authorization behavior
- Error-status mapping and minimal problem-details format
- Security controls and trust boundaries
- Persistence behavior that is externally or operationally significant

This document is a standalone requirements specification for building the service from scratch.

## 2. Scope

### In scope

- Verifying GitHub Actions OIDC bearer tokens from a fixed trusted issuer configuration
- Returning verified Caller claims without minting a token
- Minting repository-scoped GitHub App installation access tokens for allowed workflow contexts
- Authenticating Dashboard Users via GitHub App user authorization
- Listing repositories visible to an authorized Dashboard User for this GitHub App
- Rendering the last 5 Audit Log entries for a visible repository
- Receiving signed GitHub webhooks and routing them to the Installation Coordinator
- Maintaining the bounded Audit Log and Webhook Delivery Log
- Coordinating JWKS refresh and verifier state per configured OIDC issuer

### Out of scope

- Arbitrary OIDC issuers discovered from tokens
- Caller-selected GitHub permissions
- Caller-selected target repository
- Token caching or reuse
- General webhook event processing beyond acceptance, validation, routing, and persistence
- Admin write APIs or mutable repository-visibility allowlists
- Secondary Cyspbot-side repository allowlists beyond GitHub App Installation presence

## 3. Users and Callers

### Caller

GitHub Actions workflows that can mint GitHub-issued OIDC tokens and present them as bearer tokens.

### Dashboard User

A human GitHub user who authorizes the Cyspbot GitHub App and may inspect only the repositories that GitHub returns for that user and installation context.

### Upstream authorities

- GitHub OIDC issuer for caller identity
- GitHub App Installation model for repository authorization
- GitHub REST API for installation lookup, repository metadata, and GitHub App installation access-token minting

### Operators

Platform operators who configure the trusted OIDC issuer set, GitHub App identity, private key secret, webhook secret, and retention settings.

## 4. Product Outcomes

The service must:

1. Prove that the Caller is an authenticated GitHub Actions workflow from a trusted issuer.
2. Derive the calling repository from verified OIDC claims rather than caller input.
3. Confirm the configured GitHub App is installed on that repository.
4. Mint a fresh GitHub App installation access token only when the verified GitHub OIDC trust context passes policy.
5. Never expose or distribute the GitHub App private key outside the service secret boundary.
6. Persist bounded Audit Log and Webhook Delivery Log records.

## 5. External API Contract

All responses are UTF-8 encoded.

### 5.1 Authentication model

GitHub-specific protected routes require:

```http
Authorization: Bearer <oidc-token>
```

If the bearer token is missing or invalid, the service returns `401 Unauthorized` and includes:

```http
WWW-Authenticate: Bearer
```

`POST /token` also relies on OIDC token verification, but it receives the caller's OIDC token through the OAuth token exchange `subject_token` parameter rather than the `Authorization` header.

Dashboard routes use a separate authentication surface:

- The user authorizes the Cyspbot GitHub App through GitHub App user authorization.
- Cyspbot exchanges the callback code for a GitHub App user access token.
- Cyspbot stores encrypted token material in a short-lived server-side Dashboard Session and sends a signed HTTP-only session cookie.
- Repository visibility for the dashboard comes from GitHub's user-to-server installation repository APIs, not from local installation records alone.
- Visibility Refresh may upsert positive projection bootstrap rows for repositories GitHub returned for the current Dashboard User, but only Installation Reconciliation may perform full installation-slice replacement, deletion, suspension, or removal decisions.

Token Minting routes still do not accept GitHub PATs, GitHub App JWTs from Callers, or Dashboard Session cookies as substitutes for GitHub Actions OIDC authentication.

### 5.2 Error format

Error responses use `application/problem+json; charset=utf-8` with the minimal body:

```json
{
  "status": 403,
  "title": "Forbidden",
  "type": "about:blank"
}
```

No additional fields are required for compatibility.

### 5.3 `POST /github/claims`

Purpose:
Verify Caller identity and confirm that the configured GitHub App is installed on the Calling Repository, without evaluating the full Token Policy and without minting a token.

Request:

- Method: `POST`
- Body: none required
- Auth: required bearer OIDC token

Success response:

- Status: `200 OK`
- Content-Type: `application/json; charset=utf-8`
- Body:

```json
{
  "repository_id": "123456789",
  "repository": "cysp/example-repo",
  "event_name": "workflow_dispatch",
  "ref": "refs/heads/main"
}
```

Behavior:

- The repository and repository ID come from verified OIDC claims.
- `event_name` and `ref` are echoed from verified claims.
- This endpoint allows events that are not eligible for Token Minting, provided authentication succeeds and the GitHub App Installation lookup succeeds.
- Example: a verified `pull_request` event may return `200` here and still be forbidden for Token Minting.

Failure behavior:

- `401` for authentication failure
- `403` when the GitHub App is not considered installed/authorized for the repository
- `502` for upstream GitHub server failure
- `500` for local configuration or unexpected internal failure
- `405` for any method other than `POST`

### 5.4 `POST /token`

Purpose:
Primary Security Token Service endpoint. Exchange a trusted GitHub Actions OIDC token for a fresh GitHub App installation access token for the calling repository, subject to checked-in policy code over verified caller context and repository scope.

Request:

- Method: `POST`
- Content-Type: `application/x-www-form-urlencoded`
- Body:
  - `grant_type` required and must equal `urn:ietf:params:oauth:grant-type:token-exchange`
  - `subject_token` required and must contain the GitHub Actions OIDC token
  - `subject_token_type` required and must equal `urn:ietf:params:oauth:token-type:id_token` or `urn:ietf:params:oauth:token-type:jwt`
  - `requested_token_type` optional; when present, must equal either:
    - `urn:chikachow:github-app-installation-access-token`
    - `urn:ietf:params:oauth:token-type:access_token`
- Auth: no `Authorization` header required or expected for the exchanged subject token

Standards profile:

- OAuth 2.0 token endpoint shape from RFC 6749 Section 5
- OAuth 2.0 Token Exchange grant from RFC 8693
- Cyspbot defines `urn:chikachow:github-app-installation-access-token` as its issued token type because GitHub does not publish a standard URI identifier for GitHub App installation access tokens

Success response:

- Status: `200 OK`
- Content-Type: `application/json; charset=utf-8`
- Cache-Control: `no-store`
- Body:

```json
{
  "access_token": "ghs_...",
  "issued_token_type": "urn:chikachow:github-app-installation-access-token",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

Required behavior:

- Resolve the GitHub App installation for the repository from verified claims.
- Enforce the Token Policy before token creation.
- Mint a new GitHub App installation access token with:
  - repository scope restricted to the calling repository only
  - repository permissions inherited from the current GitHub App configuration for that installation
- When calling GitHub's `POST /app/installations/{installation_id}/access_tokens`, send `X-GitHub-Stateless-S2S-Token: enabled` to opt in to the temporary stateless token format override
- Return the GitHub-provided expiry timestamp.

Current default Token Policy:

- Requires verified GitHub OIDC claims to map to a GitHub Actions principal with at least:
  - `sub`
  - `event_name`
  - `repository`
  - `repository_id`
- Evaluates the verified claim set directly in service code against resolved repository metadata.
- Requires all of the following to permit Token Minting:
  - `repository_id` matches the resolved repository
  - `repository` matches the resolved repository
  - `repository_owner_id` matches the resolved repository owner
  - `repository_visibility` matches the resolved repository visibility
  - `sub` identifies the same repository as the resolved repository
  - the OIDC subject context kind is `ref`
  - the OIDC subject context value equals the repository's current default branch ref
  - the verified `ref` equals the repository's current default branch ref
  - the verified `ref_type` is `branch`
  - `event_name` is one of `schedule`, `workflow_dispatch`, or `push`
- The implementation must preserve additional verified claims such as `workflow_ref`, `job_workflow_ref`, `environment`, `head_ref`, and `base_ref` in the mapped principal so future checked-in policies can use them without changing the endpoint contract.

Forbidden event contexts:

- All other GitHub Actions event names
- All pull-request event contexts, including pull requests raised from forked repositories
- `push` where `ref` is absent
- `push` where `ref` does not match `refs/heads/<default_branch>`

Failure behavior:

- `400` with OAuth JSON error response for malformed token exchange input, unsupported token type hints, authentication failure, or disallowed event context
- `502` for upstream GitHub server failure
- `500` for local configuration errors, invalid repository ID claim shape, or unexpected internal failure
- `400` for any method other than `POST` on this endpoint

Error payloads must follow OAuth token endpoint conventions rather than `application/problem+json`.

### 5.5 `POST /github/installations/token`

Purpose:
Legacy compatibility endpoint for callers that still use the original GitHub-specific Token Minting path.

Request:

- Method: `POST`
- Body: none required
- Auth: required bearer OIDC token

Success response:

- Status: `200 OK`
- Content-Type: `application/json; charset=utf-8`
- Body:

```json
{
  "token": "ghs_...",
  "expires_at": "2030-01-01T00:00:00Z"
}
```

Required behavior:

- Must share the same OIDC verification, GitHub App Installation resolution, Token Policy enforcement, and GitHub token creation implementation as `POST /token`
- Must preserve the legacy response shape for compatibility
- Must remain secondary to `POST /token` in all primary documentation

Failure behavior:

- `401` for authentication failure
- `403` for authorization failure, disallowed event context, missing installation, or GitHub authorization-style failures
- `502` for upstream GitHub server failure
- `500` for local configuration errors, invalid repository ID claim shape, or unexpected internal failure
- `405` for any method other than `POST`

### 5.6 `POST /github/webhooks`

Purpose:
Accept authenticated GitHub webhook deliveries, validate the envelope, and route accepted deliveries to the Installation Coordinator.

Request requirements:

- Method: `POST`
- Content-Type must be `application/json` (parameters allowed)
- Required headers:
  - `X-GitHub-Event`
  - `X-GitHub-Delivery`
  - `X-Hub-Signature-256`
- Body must be valid JSON
- Maximum accepted body size: `256 KiB`

Signature behavior:

- HMAC SHA-256 using the configured webhook secret
- Header format must be `sha256=<64 lowercase hex chars>`
- Comparison must be constant-time

Success response:

- Status: `202 Accepted`
- Content-Type: `application/json; charset=utf-8`
- Body:

```json
{
  "accepted": true
}
```

For the GitHub `ping` event used to validate webhook configuration, the service must instead return:

```json
{
  "accepted": true,
  "event": "ping"
}
```

Failure behavior:

- `500` when no webhook secret is configured
- `415` for non-JSON content type
- `400` for malformed content length, missing required headers, invalid JSON, or invalid/missing `installation.id` on non-`ping` events
- `401` for invalid webhook signature
- `413` for payloads larger than `256 KiB`
- `405` for any method other than `POST`

Post-acceptance behavior:

- Persist webhook delivery metadata in D1 for deliveries that reach envelope validation, including rejected deliveries.
- The first cut stores metadata only, not raw webhook bodies or signature secrets.
- Signed `ping` deliveries are accepted after signature and JSON validation without requiring `installation.id`.
- `ping` is endpoint validation rather than installation state, so it should be handled at the Worker edge rather than routed to installation-scoped persistence.
- No further business-event processing is required for compatibility.

### 5.7 Unknown routes

- Return `404 Not Found` with minimal problem details.

### 5.8 `POST /internal/durable-objects/github-installations/migrate`

Purpose:
Temporary maintenance endpoint for forcing lazy Durable Object constructor migrations on existing `GITHUB_INSTALLATION` objects.

Request:

- Method: `POST`
- Auth: required bearer token matching the configured `MAINTENANCE_API_TOKEN`
- Content-Type: `application/json`
- Body:

```json
{
  "object_ids": ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]
}
```

- `object_ids` must be an array of 64-character hexadecimal Durable Object ID strings

Success response:

- Status: `200 OK`
- Content-Type: `application/json; charset=utf-8`
- Body:

```json
{
  "migrated": true,
  "object_ids": ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]
}
```

Required behavior:

- For each `object_id`, reconstruct the Durable Object ID using `idFromString`.
- Get a stub for that exact object.
- Invoke a no-op maintenance RPC so the object is instantiated and constructor migrations run.

Failure behavior:

- `401` for missing or invalid bearer token
- `400` for invalid request JSON or invalid Durable Object ID shape
- `415` for non-JSON request content
- `404` when `MAINTENANCE_API_TOKEN` is not configured
- `405` for any method other than `POST`

## 6. Authentication and Authorization Requirements

### 6.1 Trusted issuer model

The service must trust only a closed set of configured issuer registrations.

Current required issuer registration:

- Issuer: `https://token.actions.githubusercontent.com`
- Audience: `cyspbot`
- Allowed algorithms: `RS256`
- `kid` required: yes
- Verification source: remote JWKS
- JWKS URI: `https://token.actions.githubusercontent.com/.well-known/jwks`

Rationale:
Issuer trust must come from deployment configuration, not from untrusted token contents beyond using the unverified `iss` claim as a lookup hint into the configured registry. This avoids token-driven issuer discovery and arbitrary key fetches.

### 6.2 Principal mapping

The service must derive a GitHub Actions principal from verified token claims. Required claims for a valid principal:

- `sub`
- `event_name`
- `repository`
- `repository_id`

Optional claims preserved when present:

- `actor`
- `base_ref`
- `environment`
- `head_ref`
- `job_workflow_ref`
- `ref`
- `ref_type`
- `repository_owner_id`
- `repository_visibility`
- `run_attempt`
- `run_id`
- `sha`
- `workflow`
- `workflow_ref`

If the token verifies cryptographically but does not map to a valid principal shape, authentication fails.

### 6.3 Repository authorization model

Repository authorization is based on GitHub App installation presence on the calling repository.

Required behavior:

- The service must not accept a caller-supplied repository parameter.
- The service must derive the repository exclusively from verified OIDC claims.
- The service must treat the GitHub App installation as the authority for whether the repository is eligible.

Rationale:
This removes a large class of confused-deputy and cross-repository escalation risks. The caller can only obtain a token for the repository GitHub asserted in the OIDC token and for which the app is actually installed.

### 6.4 Token mint policy

The service must enforce a checked-in policy implementation for caller eligibility and repository scope:

- No caller-selected permissions
- No caller-selected repository
- No Token Minting for PR-triggered events
- No Token Minting for pull requests raised from forked repositories under any circumstance
- `push`, `schedule`, and `workflow_dispatch` only when the verified OIDC `sub` and `ref` both identify the current default branch ref
- Repository permissions must be inherited from the GitHub App configuration in effect at mint time
- Additional verified claims such as `workflow_ref`, `job_workflow_ref`, `environment`, `head_ref`, and `base_ref` must remain available to the policy layer for future stricter checked-in policies

Rationale:
The implemented service is intentionally narrow. The Caller proves identity; Cyspbot decides caller eligibility and repository scope through checked-in policy code; GitHub App configuration decides repository permissions. This prevents workflows from widening scope to arbitrary repositories or using Cyspbot as a generic GitHub token vending endpoint, while intentionally treating the GitHub App configuration as the primary authorization control plane.

## 7. OIDC Verification Requirements

### 7.1 Verification flow

The service must:

1. Extract a bearer token.
2. Parse an unverified issuer hint from the JWT payload.
3. Load a matching configured issuer registration.
4. Route verification through the verifier component associated with that issuer.
5. Enforce issuer, audience, algorithm, lifetime, and principal-shape validation.

### 7.2 JWKS handling

The verifier must:

- Fetch JWKS over HTTPS
- Accept only fully valid, normalized JWKS snapshots
- Reject empty or unusable JWKS documents
- Clamp freshness using service-owned bounds rather than trusting upstream cache headers directly

Current freshness policy:

- Default fresh window: 5 minutes
- Minimum fresh window: 1 minute
- Maximum fresh window: 15 minutes
- Stale-while-error window: 10 minutes

### 7.3 Refresh and backoff behavior

The verifier must:

- Refresh when no snapshot exists
- Refresh when the snapshot is no longer fresh
- Refresh when a token references an unknown `kid`
- Make at most one guarded extra refresh attempt for an unknown `kid`
- Serve a stale snapshot temporarily during bounded upstream failure windows
- Apply exponential backoff on refresh failures

Current backoff policy:

- Base backoff: 5 seconds
- Maximum backoff: 5 minutes
- Separate consecutive counters for transport failures and invalid-JWKS failures

Rationale:
This design reduces duplicate JWKS fetches across execution contexts and keeps verification available during short upstream disruption without accepting uncontrolled staleness.

### 7.4 Verification failure mapping

Verification failures are operationally logged but surfaced to callers as:

- `401` for token/authentication failures
- `500` only for local verifier configuration errors

The public API does not expose detailed token-validation reasons.

## 8. GitHub API Requirements

The service must call GitHub's REST API as the configured GitHub App.

### 8.1 App authentication

Required behavior:

- Construct a GitHub App JWT signed with the configured private key
- Use `RS256`
- Set `iss` to the configured GitHub App ID
- Use a short lifetime

Current behavior:

- Issued-at is backdated by 60 seconds
- JWT expiry is 9 minutes after the current time

### 8.2 Private key handling

Required behavior:

- Prefer the secret-store-backed private key in production-compatible environments
- Allow a direct PEM environment variable only for local development or tests
- Expect PKCS#8 PEM format
- Cache imported private keys in-memory per PEM value

Rationale:
Keeping the GitHub App private key inside the platform secret boundary is the main product reason for the service. A local env var fallback is acceptable only for development and test compatibility.

### 8.3 Required GitHub API operations

The service must support:

- `GET /repos/{owner}/{repo}/installation`
- `GET /repos/{owner}/{repo}`
- `POST /app/installations/{installation_id}/access_tokens`

Required GitHub access-token request body:

```json
{
  "repository_ids": [123456789]
}
```

Required GitHub access-token request headers:

```http
X-GitHub-Stateless-S2S-Token: enabled
```

### 8.4 GitHub error normalization

The service must normalize GitHub API failures as follows:

- GitHub `400` -> service `500`
- GitHub `401`, `403`, or `404` -> service `403`
- GitHub `5xx` -> service `502`
- Invalid response shape from GitHub -> service `502`

Rationale:
The service intentionally hides internal GitHub authorization details and presents callers with a small stable error surface.

## 9. Persistence and Isolation Boundaries

The durable persistence model for the Dashboard Sessions, Repository Visibility Cache, Audit Log, and Webhook Delivery Log is defined in [docs/dashboard-d1-recut.md](/Users/STalbot@Scentregroup.com/src/cysp/cyspbot/docs/dashboard-d1-recut.md).

### 9.1 Audit Log persistence

The service must durably persist Audit Log facts and issued-token facts in the central durable store chosen for the re-cut.

Required stored Audit Log fields include:

- requested-at timestamp
- Caller repository ID from normalized GitHub-issued OIDC Caller context
- Caller repository full name normalized from the GitHub-issued OIDC `repository` claim
- Caller repository full name display snapshot from the original GitHub-issued OIDC `repository` claim, for display and audit evidence only
- installation ID when live GitHub installation lookup succeeds
- GitHub Actions event name
- GitHub ref
- GitHub ref type
- GitHub actor
- outcome
- OIDC subject
- OIDC issuer
- OIDC resolved key ID when available
- GitHub workflow and run identifiers needed for investigation
- outcome reason codes in relational child rows for policy denials and stable lookup or internal failure reasons
- issued-token expiry in a 0-or-1 issued-token child row when Token Minting succeeds
- issued-token permissions in relational child rows when Token Minting succeeds

Normalized columns are the only columns allowed for identity, route resolution, joins, authorization, and uniqueness. Display snapshot columns exist only to show what GitHub reported at the time and must carry a `_display` suffix.

The audit intent row must be written after OIDC authentication produces normalized Caller context and before any live GitHub App Installation or repository lookup. Live GitHub lookup failures after Caller authentication must finalize that row instead of disappearing into transient operational logs.

Terminal audit finalization and issued-token child rows must be written transactionally where the central store supports it. If a token has already been minted but finalization cannot be persisted, the service must return a server error. A persisted `finalization_failed` marker is only guaranteed when the central store can accept that failure update; otherwise the pending audit intent row plus an operational alert is the evidence trail.

### 9.2 Installation Coordinator

The service must preserve an Installation Coordinator for Installation Reconciliation execution.

Required installation-scoped behavior:

- one Installation Coordinator boundary per GitHub App Installation
- signal coalescing for repeated Installation Reconciliation requests
- serialized Installation Reconciliation execution for one installation at a time
- minimal reconstructable Durable Object state only

The Installation Coordinator is not the durable source of truth for the Audit Log, Dashboard Sessions, repository projection, or Repository Visibility Cache.

### 9.3 Webhook Delivery Log persistence

Webhook Delivery Log metadata is required durable audit data. The first cut stores metadata only rather than raw bodies.

Required stored webhook metadata fields:

- receive timestamp
- installation ID when present
- delivery ID
- GitHub webhook event name
- acceptance result
- signature validation result
- response status code
- optional small metadata JSON for operational debugging

Rationale:
The target re-cut preserves GitHub App Installation isolation for execution while moving durable facts into one centrally queryable store.

### 9.4 Retention and bounding

Retention policy is defined per durable table in the re-cut document. The baseline requirements are:

- Audit Log and issued-token child rows: bounded and purged explicitly
- Dashboard Session rows and Repository Visibility Cache rows: aggressively purged after expiry
- Installation Reconciliation status and Webhook Delivery Log metadata: bounded by explicit retention windows

The implementation must use explicit cleanup jobs rather than relying only on opportunistic deletion during request handling.

### 9.5 Verifier-state isolation

OIDC verification state must be isolated per configured issuer registration.

Required persisted verifier state:

- normalized JWKS snapshot
- freshness and stale-window timestamps
- refresh-failure backoff state
- registration fingerprint used to invalidate persisted state when configuration changes

Rationale:
Issuer-scoped isolation prevents one issuer's refresh policy or corrupted state from affecting another issuer and gives a clear cache-coordination boundary.

## 10. Observability and Logging

The service must log operational failures server-side, including:

- authentication failures with coarse reason and request metadata
- GitHub App Installation lookup failures
- Token Minting failures with mapped status and Caller context
- issuer-registration loading/configuration failures

The public API must remain minimally descriptive even when logs are richer.

No metrics, tracing schema, or external log-query API are required for compatibility.

## 11. Security Requirements

### 11.1 Secret boundaries

- The GitHub App private key must not be exposed to callers.
- The webhook secret must not be exposed to callers.
- Minted GitHub App installation access tokens must not be persisted for reuse.

### 11.2 Caller constraints

- Only verified GitHub Actions OIDC Callers are eligible.
- Only configured issuers are trusted.
- Only the repository asserted by verified claims may receive a token.
- Only the repository asserted by verified claims may receive a repository-scoped token, while repository permissions are inherited from the GitHub App configuration in effect at mint time.

### 11.3 Fail-closed behavior

- Unknown issuer -> authentication failure
- Missing `kid` where required -> authentication failure
- Invalid webhook signature -> reject
- Missing webhook secret -> server error, not permissive accept
- Missing installation context in webhook body -> reject for non-`ping` events

### 11.4 Response minimization

The service should not disclose detailed validation failures, GitHub authorization internals, or secret/config state beyond coarse HTTP status classes.

Rationale:
The implemented design prefers a narrow public surface and richer operator-side logs. That is the correct tradeoff for a Security Token Service.

## 12. Non-Functional Requirements

### 12.1 Contract stability

The service must preserve the route paths, methods, field names, and status semantics defined here.

### 12.2 Statelessness of token issuance

Each Token Minting request must produce a fresh GitHub App installation access token. Reuse from local cache is not allowed.

### 12.3 Bounded memory and persistence

Verifier caches, private-key imports, and persisted logs must remain bounded by the policies above.

### 12.4 Unicode safety

The service must correctly handle non-ASCII verified claim values without corrupting authentication or response generation.

## 13. Deliberate Non-Goals and Constraints

The service must not require any of the following behaviors:

- Caller-supplied permission profiles
- Cross-repository Token Minting
- Webhook replay API
- Audit-log read API
- Dynamic issuer registration
- Generic JWT introspection endpoint
- Partial or opportunistic webhook acceptance without signature validation

These are intentionally absent from the current product surface.

## 14. Acceptance Criteria

The implementation is acceptable only if all of the following are true:

1. `POST /github/claims` accepts a valid GitHub Actions OIDC bearer token and returns the verified repository identity fields without requiring a Token Minting-eligible event context.
2. `POST /token` accepts an RFC 8693 token exchange request, validates a GitHub Actions OIDC `subject_token`, and returns an OAuth-style token response for allowed workflow contexts.
3. `POST /github/installations/token` remains available as a compatibility endpoint and shares the same Token Policy and upstream GitHub token creation path as `POST /token`.
4. The GitHub access-token request sent upstream is restricted to the Calling Repository ID, does not send a server-defined `permissions` override, and opts in to GitHub's temporary stateless token format header.
5. Authentication trusts only configured issuers and verifies against coordinated per-issuer JWKS state with bounded freshness, stale serving, and backoff.
6. `POST /github/webhooks` rejects malformed, oversized, unsigned, or incorrectly signed deliveries; accepts valid signed JSON deliveries with positive integer `installation.id`; and also accepts signed `ping` validation deliveries without `installation.id`.
7. Authenticated Token Minting attempts are durably persisted in the central Audit Log before live GitHub lookup, every Audit Log row records the domain outcome, successful token mints record the actual permission set GitHub returned in relational child rows, denials and stable failure reasons are recorded in relational child rows, and the final Token Minting response fails closed if the required audit write cannot be persisted.
8. Errors are returned as minimal `application/problem+json` responses for legacy GitHub-specific endpoints and OAuth-style JSON token responses for `POST /token`.
9. The GitHub App private key remains inside the service secret boundary and is never returned or persisted in logs or API responses.

## 15. Implementation Constraints

The service does not need to use Cloudflare Workers or Durable Objects internally, but it must preserve the same externally relevant guarantees:

- one Installation Coordinator boundary for Installation Reconciliation execution
- one issuer-scoped verifier coordination boundary for JWKS state
- a secure secret boundary for the GitHub App private key
- no broadening of caller authority, token scope, or public API surface

If a platform choice cannot preserve those guarantees cleanly, it is not suitable for this service even if the route handlers appear similar.
