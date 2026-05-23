# Product Requirements Document: GitHub Actions Installation Token Broker Service

## 1. Purpose

The service exists to let approved GitHub Actions workflows obtain short-lived GitHub App installation tokens without exposing the GitHub App private key to GitHub Actions runners or other caller-controlled environments.

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
- Returning verified caller claims without minting a token
- Minting repository-scoped GitHub installation tokens for allowed workflow contexts
- Receiving signed GitHub webhooks and routing them to installation-scoped persistence
- Maintaining bounded per-installation audit and webhook-delivery logs
- Coordinating JWKS refresh and verifier state per configured OIDC issuer

### Out of scope

- Arbitrary OIDC issuers discovered from tokens
- Caller-selected GitHub permissions
- Caller-selected target repository
- Token caching or reuse
- General webhook event processing beyond acceptance, validation, routing, and persistence
- End-user UI, admin API, or log-query API
- Secondary broker-side repository allowlists beyond GitHub App installation presence

## 3. Users and Callers

### Primary caller

GitHub Actions workflows that can mint GitHub-issued OIDC tokens and present them as bearer tokens.

### Upstream authorities

- GitHub OIDC issuer for caller identity
- GitHub App installation model for repository authorization
- GitHub REST API for installation lookup, repository metadata, and installation-token minting

### Operators

Platform operators who configure the trusted OIDC issuer set, GitHub App identity, private key secret, webhook secret, and retention settings.

## 4. Product Outcomes

The service must:

1. Prove that the caller is an authenticated GitHub Actions workflow from a trusted issuer.
2. Derive the calling repository from verified OIDC claims rather than caller input.
3. Confirm the configured GitHub App is installed on that repository.
4. Mint a fresh installation token only when the workflow event context passes policy.
5. Never expose or distribute the GitHub App private key outside the service secret boundary.
6. Persist bounded operational records for token requests and accepted webhook deliveries.

## 5. External API Contract

All responses are UTF-8 encoded.

### 5.1 Authentication model

Protected routes require:

```http
Authorization: Bearer <oidc-token>
```

If the bearer token is missing or invalid, the service returns `401 Unauthorized` and includes:

```http
WWW-Authenticate: Bearer
```

Authentication is based on OIDC token verification. The service does not accept GitHub PATs, GitHub App JWTs from callers, API keys, cookies, or session credentials.

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
Verify caller identity and confirm that the configured GitHub App is installed on the calling repository, without evaluating full token-mint policy and without minting a token.

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
- This endpoint allows otherwise non-mintable events, provided authentication succeeds and the app installation lookup succeeds.
- Example: a verified `pull_request` event may return `200` here and still be forbidden for token minting.

Failure behavior:

- `401` for authentication failure
- `403` when the GitHub App is not considered installed/authorized for the repository
- `502` for upstream GitHub server failure
- `500` for local configuration or unexpected internal failure
- `405` for any method other than `POST`

### 5.4 `POST /github/installations/token`

Purpose:
Mint a fresh GitHub installation token for the calling repository, subject to fixed policy.

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

- Resolve the GitHub App installation for the repository from verified claims.
- Enforce token mint policy before token creation.
- Mint a new installation token with:
  - repository scope restricted to the calling repository only
  - fixed permissions only:
    - `contents: write`
    - `pull_requests: write`
- Return the GitHub-provided expiry timestamp.

Allowed event contexts:

- `schedule`
- `workflow_dispatch`
- `push` only when `ref` equals the repository's current default branch ref

Forbidden event contexts:

- All other GitHub Actions event names
- All pull-request event contexts, including pull requests raised from forked repositories
- `push` where `ref` is absent
- `push` where `ref` does not match `refs/heads/<default_branch>`

Failure behavior:

- `401` for authentication failure
- `403` for authorization failure, disallowed event context, missing installation, or GitHub authorization-style failures
- `502` for upstream GitHub server failure
- `500` for local configuration errors, invalid repository ID claim shape, or unexpected internal failure
- `405` for any method other than `POST`

### 5.5 `POST /github/webhooks`

Purpose:
Accept authenticated GitHub webhook deliveries, validate the envelope, and route accepted deliveries to installation-scoped persistence.

Request requirements:

- Method: `POST`
- Content-Type must be `application/json` (parameters allowed)
- Required headers:
  - `X-GitHub-Event`
  - `X-GitHub-Delivery`
  - `X-Hub-Signature-256`
- Body must be valid JSON
- Body must contain `installation.id` as a positive integer
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

Failure behavior:

- `500` when no webhook secret is configured
- `415` for non-JSON content type
- `400` for malformed content length, missing required headers, invalid JSON, or invalid/missing `installation.id`
- `401` for invalid webhook signature
- `413` for payloads larger than `256 KiB`
- `405` for any method other than `POST`

Post-acceptance behavior:

- Persist the raw JSON body string, delivery ID, event name, signature header, installation ID, and receive timestamp in the installation-scoped webhook log.
- No further business-event processing is required for compatibility.

### 5.6 Unknown routes

- Return `404 Not Found` with minimal problem details.

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

- `event_name`
- `repository`
- `repository_id`

Optional claims preserved when present:

- `actor`
- `ref`
- `run_attempt`
- `run_id`
- `sha`
- `workflow`

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

The service must enforce a fixed mint policy:

- No caller-selected permissions
- No caller-selected repository
- No token minting for PR-triggered events
- No token minting for pull requests raised from forked repositories under any circumstance
- `push` only on the current default branch

Rationale:
The implemented service is intentionally narrow. The caller proves identity; the broker decides token shape. This prevents workflows from widening permissions or using the broker as a generic GitHub token vending endpoint.

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

Required token request body:

```json
{
  "permissions": {
    "contents": "write",
    "pull_requests": "write"
  },
  "repository_ids": [123456789]
}
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

### 9.1 Installation-scoped persistence

The service must isolate token-request audit logs and accepted webhook-delivery logs by GitHub App installation ID.

Required stored token-request fields:

- request timestamp
- repository ID
- repository name
- installation ID
- event name
- ref
- actor
- workflow
- run ID
- run attempt
- commit SHA
- resulting status
- token expiry when minting succeeds

Required stored webhook fields:

- receive timestamp
- installation ID
- delivery ID
- event name
- signature header
- raw body

Rationale:
Installation-scoped persistence keeps operational records close to the authorization boundary and avoids a global shared mutable store for unrelated repositories.

### 9.2 Retention and bounding

Both token-request and webhook logs must be bounded by:

- maximum age: 180 days by default
- maximum entries: 5000 by default

The implementation must prune older records by age and then by newest-first entry count.

### 9.3 Verifier-state isolation

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
- GitHub installation lookup failures
- token mint failures with mapped status and caller context
- issuer-registration loading/configuration failures

The public API must remain minimally descriptive even when logs are richer.

No metrics, tracing schema, or external log-query API are required for compatibility.

## 11. Security Requirements

### 11.1 Secret boundaries

- The GitHub App private key must not be exposed to callers.
- The webhook secret must not be exposed to callers.
- Minted installation tokens must not be persisted for reuse.

### 11.2 Caller constraints

- Only verified GitHub Actions OIDC callers are eligible.
- Only configured issuers are trusted.
- Only the repository asserted by verified claims may receive a token.
- Only the fixed permission set may be minted.

### 11.3 Fail-closed behavior

- Unknown issuer -> authentication failure
- Missing `kid` where required -> authentication failure
- Invalid webhook signature -> reject
- Missing webhook secret -> server error, not permissive accept
- Missing installation context in webhook body -> reject

### 11.4 Response minimization

The service should not disclose detailed validation failures, GitHub authorization internals, or secret/config state beyond coarse HTTP status classes.

Rationale:
The implemented design prefers a narrow public surface and richer operator-side logs. That is the correct tradeoff for a security broker.

## 12. Non-Functional Requirements

### 12.1 Contract stability

The service must preserve the route paths, methods, field names, and status semantics defined here.

### 12.2 Statelessness of token issuance

Each token mint request must produce a fresh GitHub installation token. Reuse from local cache is not allowed.

### 12.3 Bounded memory and persistence

Verifier caches, private-key imports, and persisted logs must remain bounded by the policies above.

### 12.4 Unicode safety

The service must correctly handle non-ASCII verified claim values without corrupting authentication or response generation.

## 13. Deliberate Non-Goals and Constraints

The service must not require any of the following behaviors:

- Caller-supplied permission profiles
- Cross-repository token minting
- Webhook replay API
- Audit-log read API
- Dynamic issuer registration
- Generic JWT introspection endpoint
- Partial or opportunistic webhook acceptance without signature validation

These are intentionally absent from the current product surface.

## 14. Acceptance Criteria

The implementation is acceptable only if all of the following are true:

1. `POST /github/claims` accepts a valid GitHub Actions OIDC bearer token and returns the verified repository identity fields without requiring mintable event context.
2. `POST /github/installations/token` mints a new installation token only for `schedule`, `workflow_dispatch`, and default-branch `push`.
3. The minted token request sent upstream is restricted to the calling repository ID and the fixed `contents` and `pull_requests` write permissions.
4. Authentication trusts only configured issuers and verifies against coordinated per-issuer JWKS state with bounded freshness, stale serving, and backoff.
5. `POST /github/webhooks` rejects malformed, oversized, unsigned, or incorrectly signed deliveries and accepts valid signed JSON deliveries with positive integer `installation.id`.
6. Accepted token requests and accepted webhook deliveries are persisted in bounded installation-scoped logs.
7. Errors are returned as minimal `application/problem+json` responses with the status/title/type shape described above.
8. The GitHub App private key remains inside the service secret boundary and is never returned or persisted in logs or API responses.

## 15. Implementation Constraints

The service does not need to use Cloudflare Workers or Durable Objects internally, but it must preserve the same externally relevant guarantees:

- one installation-scoped persistence boundary for audit and webhook records
- one issuer-scoped verifier coordination boundary for JWKS state
- a secure secret boundary for the GitHub App private key
- no broadening of caller authority, token scope, or public API surface

If a platform choice cannot preserve those guarantees cleanly, it is not suitable for this service even if the route handlers appear similar.
