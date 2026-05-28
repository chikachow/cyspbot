# cyspbot Service Contract

This document is the canonical implementation contract for cyspbot.

The purpose of this document is not to describe the TypeScript or Cloudflare implementation. It describes the current interface, semantics, security boundaries, durable facts, and externally observable behaviour closely enough that the service could be reimplemented in another language or runtime without changing what callers, GitHub, dashboard users, or operators observe.

## 1. Product Boundary

cyspbot is a hosted Security Token Service for GitHub Actions workflows.

It verifies GitHub Actions OIDC tokens from a closed set of trusted issuers, derives the calling repository from verified claims, confirms that the configured GitHub App is installed on that repository, and issues a fresh repository-scoped GitHub App installation access token only when the verified workflow context passes cyspbot policy.

The service also exposes a small dashboard for humans who authorize the same GitHub App through GitHub App user authorization. Dashboard users can see only repositories GitHub returns for that human user through GitHub's user-to-server installation repository APIs. Dashboard users can toggle pull request haiku opt-ins only for repositories where GitHub reports they have repository `admin` permission.

## 2. Public Route Matrix

All route matching is exact unless noted.

| Route                                  | Method | Purpose                                                                      | Success                       |
| -------------------------------------- | ------ | ---------------------------------------------------------------------------- | ----------------------------- |
| `/`                                    | `GET`  | Hosted origin entrypoint                                                     | `302` to `/dashboard`         |
| `/token`                               | `POST` | OAuth token exchange for Installation Token Issuance                         | `200` JSON                    |
| `/github/claims`                       | `POST` | Verify caller identity and app installation presence without issuing a token | `200` JSON                    |
| `/github/webhooks`                     | `POST` | Receive signed GitHub App webhook deliveries                                 | `202` JSON                    |
| `/github/setup`                        | `GET`  | Receive GitHub App install/update setup redirects                            | `302` to dashboard login      |
| `/login/github`                        | `GET`  | Start dashboard GitHub App user authorization                                | `302` to GitHub               |
| `/auth/github/callback`                | `GET`  | Complete dashboard GitHub App user authorization                             | `302` to stored return target |
| `/logout`                              | `GET`  | Delete dashboard session                                                     | `302` to `/dashboard`         |
| `/dashboard`                           | `GET`  | Repository audit dashboard list                                              | `200` HTML or login redirect  |
| `/dashboard/pull-request-haikus`       | `GET`  | Pull request haiku repository opt-in list                                    | `200` HTML or login redirect  |
| `/dashboard/pull-request-haikus`       | `POST` | Toggle pull request haiku repository opt-in                                  | `302` or problem details      |
| `/dashboard/repositories/:owner/:name` | `GET`  | Repository audit dashboard detail                                            | `200` HTML or login redirect  |

Unknown routes return `404` problem details.

For all routes except `/token`, unsupported methods return `405` problem details with an `Allow` header naming the supported method. For `/token`, unsupported methods return the OAuth token endpoint error shape with status `400` and `{"error":"invalid_request"}`.

## 3. Response Formats

### JSON

JSON responses use:

```http
Content-Type: application/json; charset=utf-8
```

### Problem Details

Non-token API errors use a minimal problem-details response:

```http
Content-Type: application/problem+json; charset=utf-8
```

```json
{
  "status": 403,
  "title": "Forbidden",
  "type": "about:blank"
}
```

The body contains only `status`, `title`, and `type`. The title is the standard title for the status code. Public problem responses intentionally do not include internal reason codes, upstream GitHub details, validation traces, request IDs, or secret/configuration hints.

Current status titles:

| Status | Title                    |
| ------ | ------------------------ |
| `400`  | `Bad Request`            |
| `401`  | `Unauthorized`           |
| `403`  | `Forbidden`              |
| `404`  | `Not Found`              |
| `405`  | `Method Not Allowed`     |
| `413`  | `Payload Too Large`      |
| `415`  | `Unsupported Media Type` |
| `429`  | `Too Many Requests`      |
| `500`  | `Internal Server Error`  |
| `502`  | `Bad Gateway`            |

### OAuth Token Endpoint Errors

`POST /token` errors use OAuth-style JSON:

```http
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Pragma: no-cache
```

```json
{
  "error": "invalid_request"
}
```

The only public error codes currently emitted by `/token` are:

- `invalid_request`
- `unsupported_grant_type`
- `invalid_target`
- `server_error`

## 4. Caller Authentication

### Bearer OIDC Authentication

`POST /github/claims` requires:

```http
Authorization: Bearer <github-actions-oidc-token>
```

The scheme comparison is case-insensitive. A missing, non-bearer, or empty bearer token returns `401` problem details with:

```http
WWW-Authenticate: Bearer
```

`POST /token` does not use the `Authorization` header for caller authentication. It receives the caller's OIDC token in the form field `subject_token`.

Dashboard cookies do not authenticate callers for token issuance. GitHub PATs, caller-supplied GitHub App JWTs, GitHub user access tokens, and dashboard sessions are not substitutes for GitHub Actions OIDC.

### Trusted Issuer Registry

Issuer trust is static configuration. The service may parse the unverified `iss` claim as a lookup hint, but it never discovers issuers or JWKS URIs from untrusted tokens.

Current configured issuer:

| Field              | Value                                                          |
| ------------------ | -------------------------------------------------------------- |
| Issuer             | `https://token.actions.githubusercontent.com`                  |
| Audience           | `cyspbot`                                                      |
| JWKS URI           | `https://token.actions.githubusercontent.com/.well-known/jwks` |
| Allowed algorithms | `RS256`                                                        |
| `kid` required     | yes                                                            |
| Principal kind     | `github-actions`                                               |

Unknown issuer, missing issuer, malformed token, invalid signature, invalid lifetime, audience mismatch, issuer mismatch, missing required `kid`, unknown key, unsupported algorithm, or invalid principal claims are authentication failures. Public responses expose only `401` for token/authentication failures, except local verifier configuration errors, which return a server error.

### GitHub Actions Principal Mapping

A verified token maps to a GitHub Actions principal only when these claims are present and non-empty strings:

- `sub`
- `event_name`
- `repository`
- `repository_id`

Optional string claims are preserved when present:

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

The `sub` claim is parsed as:

```text
repo:<repository>:<context_kind>[:<context_value>]
```

The parsed repository and context value are percent-decoded when possible. If percent decoding fails, the raw component is retained. If `ref_type` is absent, it is inferred from `ref` when `ref` starts with `refs/heads/`, `refs/tags/`, or `refs/pull/`.

## 5. `POST /github/claims`

Purpose: verify the caller's OIDC identity and confirm that the configured GitHub App is installed for the calling repository. This endpoint does not evaluate the full token policy and does not issue an installation token.

Request:

```http
POST /github/claims
Authorization: Bearer <github-actions-oidc-token>
```

No body is required.

Success:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
```

```json
{
  "event_name": "workflow_dispatch",
  "ref": "refs/heads/main",
  "repository": "owner/example",
  "repository_id": "123456789"
}
```

Semantics:

- `repository`, `repository_id`, `event_name`, and `ref` are derived from verified claims.
- The endpoint calls GitHub to resolve the configured app installation for the verified repository.
- A workflow event that is not eligible for Installation Token Issuance can still receive `200` here. For example, a verified `pull_request` token may pass `/github/claims` and later fail `/token`.

Failure mapping:

| Condition                                                 | Status                                |
| --------------------------------------------------------- | ------------------------------------- |
| Missing or invalid bearer token                           | `401` plus `WWW-Authenticate: Bearer` |
| Verified principal is not a GitHub Actions principal      | `403`                                 |
| GitHub installation lookup returns `401`, `403`, or `404` | `403`                                 |
| GitHub installation lookup returns `5xx`                  | `502`                                 |
| GitHub installation response shape is invalid             | `502`                                 |
| Local configuration or unexpected internal error          | `500`                                 |

## 6. `POST /token`

Purpose: exchange a verified GitHub Actions OIDC token for a fresh GitHub App installation access token for the calling repository.

Request:

```http
POST /token
Content-Type: application/x-www-form-urlencoded
```

Required form fields:

| Field                | Required value                                                                        |
| -------------------- | ------------------------------------------------------------------------------------- |
| `grant_type`         | `urn:ietf:params:oauth:grant-type:token-exchange`                                     |
| `subject_token`      | non-empty GitHub Actions OIDC token                                                   |
| `subject_token_type` | `urn:ietf:params:oauth:token-type:id_token` or `urn:ietf:params:oauth:token-type:jwt` |

Optional form field:

| Field                  | Accepted values                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `requested_token_type` | absent, `urn:chikachow:github-app-installation-access-token`, or `urn:ietf:params:oauth:token-type:access_token` |

Form parameters are accepted only when there is exactly one value for required fields. Missing or repeated required fields are invalid. Repeated `requested_token_type` is treated the same as absent because it is an optional hint.

Success:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Pragma: no-cache
```

```json
{
  "access_token": "ghs_...",
  "expires_in": 3600,
  "issued_token_type": "urn:chikachow:github-app-installation-access-token",
  "token_type": "Bearer"
}
```

`expires_in` is the non-negative whole-second difference between the current service time and GitHub's returned `expires_at`. If the expiry timestamp cannot be parsed, `expires_in` is `0`.

### Issuance Flow

On an authenticated request, the service performs these steps in order:

1. Verify the OIDC subject token.
2. Map it to a GitHub Actions principal.
3. Write a durable audit intent row.
4. Resolve the GitHub App installation for the principal's repository with `GET /repos/{owner}/{repo}/installation` using GitHub App authentication.
5. Create a repository-scoped metadata token for the calling repository with permission `metadata: read`.
6. Fetch current repository metadata with `GET /repos/{owner}/{repo}` using the metadata token.
7. Evaluate the token policy against verified OIDC claims and live repository metadata.
8. Create the final repository-scoped installation token with checked-in permissions.
9. Persist terminal audit outcome, issued token expiry, and returned permissions.
10. Return the token response.

No GitHub installation lookup or access-token request occurs unless the audit intent row has been written successfully.

If GitHub issues the final token but the terminal audit write fails, the service returns a server error instead of returning the token.

### GitHub Installation Token Request

The final upstream request is:

```http
POST /app/installations/{installation_id}/access_tokens
Accept: application/vnd.github+json
Authorization: Bearer <github-app-jwt>
Content-Type: application/json
User-Agent: cyspbot
X-GitHub-Api-Version: 2022-11-28
X-GitHub-Stateless-S2S-Token: enabled
```

```json
{
  "repository_ids": [123456789],
  "permissions": {
    "contents": "write",
    "pull_requests": "write"
  }
}
```

The `repository_ids` array contains only the repository ID derived from verified claims. The caller cannot choose additional repositories or permissions.

### Token Policy

The current token policy allows issuance only when all checks pass:

- `event_name` is `schedule` or `workflow_dispatch`.
- `repository_id` equals the live repository ID.
- `repository` equals the live repository full name used for lookup.
- `repository_owner_id` equals the live repository owner ID.
- `repository_visibility` equals the live repository visibility.
- The parsed subject repository equals the live repository full name.
- The parsed subject context kind is `ref`.
- The parsed subject context value equals `refs/heads/<default_branch>`.
- The verified `ref` equals `refs/heads/<default_branch>`.
- The effective `ref_type` is `branch`.

The following contexts are denied:

- `push`
- `pull_request`
- `pull_request_target`
- pull request subject contexts
- tag refs
- non-default branch refs
- unsupported event names
- repository identity, owner, visibility, subject, or ref mismatches

Allowed issuance requests ask GitHub for:

```json
{
  "contents": "write",
  "pull_requests": "write"
}
```

GitHub App installation permissions remain the upper bound. cyspbot does not widen permissions beyond what the app installation grants.

### Token Endpoint Failure Mapping

| Condition                                                                                                                                | Status | Body                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------ |
| Unsupported method                                                                                                                       | `400`  | `{"error":"invalid_request"}`        |
| Missing or non-form content type                                                                                                         | `400`  | `{"error":"invalid_request"}`        |
| Wrong `grant_type` or repeated/missing `grant_type`                                                                                      | `400`  | `{"error":"unsupported_grant_type"}` |
| Missing or empty `subject_token`                                                                                                         | `400`  | `{"error":"invalid_request"}`        |
| Missing or unsupported `subject_token_type`                                                                                              | `400`  | `{"error":"invalid_request"}`        |
| Unsupported `requested_token_type`                                                                                                       | `400`  | `{"error":"invalid_request"}`        |
| OIDC authentication failure                                                                                                              | `400`  | `{"error":"invalid_request"}`        |
| Local OIDC verifier configuration failure                                                                                                | `500`  | `{"error":"server_error"}`           |
| Policy denial                                                                                                                            | `400`  | `{"error":"invalid_target"}`         |
| GitHub installation absence or authorization denial                                                                                      | `400`  | `{"error":"invalid_target"}`         |
| GitHub upstream `5xx`                                                                                                                    | `502`  | `{"error":"server_error"}`           |
| Local configuration, invalid GitHub response shape, invalid repository ID shape, audit persistence failure, or unexpected internal error | `500`  | `{"error":"server_error"}`           |

## 7. `POST /github/webhooks`

Purpose: accept signed GitHub App webhook deliveries and signal installation reconciliation.

Request requirements:

- Method: `POST`
- `Content-Type: application/json`, with parameters allowed
- `X-GitHub-Event` header
- `X-GitHub-Delivery` header
- `X-GitHub-Hook-Installation-Target-Type: integration`
- `X-GitHub-Hook-Installation-Target-ID` equal to configured `GITHUB_APP_ID`
- `X-Hub-Signature-256` header
- JSON body
- Body size at most `256 KiB`

The service checks that `GITHUB_WEBHOOK_SECRET` is configured before any request validation. If the secret is absent or empty, every webhook request returns `500`.

Target semantics:

- `X-GitHub-Hook-Installation-Target-Type` must be `integration`.
- `X-GitHub-Hook-Installation-Target-ID` must match the configured GitHub App ID.
- Target validation runs after required envelope headers are present and before HMAC verification.

Signature semantics:

- HMAC SHA-256 over the exact request body bytes
- secret is the configured webhook secret text
- header format is exactly `sha256=<64 lowercase hex characters>`
- uppercase hex, missing prefix, malformed hex, or length mismatch is invalid
- comparison is constant-time after length validation

Success for non-`ping` events:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json; charset=utf-8
```

```json
{
  "accepted": true
}
```

Success for signed `ping` events:

```json
{
  "accepted": true,
  "event": "ping"
}
```

Webhook event semantics:

- `ping` requires valid signature and valid JSON but does not require `installation.id`.
- Any non-`ping` event currently requires `installation.id` to be a positive JSON integer.
- The current implementation does not enforce an event allowlist after signature validation. Any signed non-`ping` event with a positive integer `installation.id` signals reconciliation for that installation.
- Raw bodies are not stored.
- Signature secrets and signature headers are not stored.

Failure mapping:

| Condition                                                   | Status                                            |
| ----------------------------------------------------------- | ------------------------------------------------- |
| Webhook secret missing                                      | `500`                                             |
| Unsupported method                                          | `405`                                             |
| Missing or non-JSON content type                            | `415`                                             |
| Malformed `Content-Length`                                  | `400`                                             |
| Declared or actual body larger than `256 KiB`               | `413`                                             |
| Missing required GitHub headers                             | `400`                                             |
| GitHub App target type or ID mismatch                       | `401`                                             |
| Invalid signature                                           | `401`                                             |
| Malformed JSON after valid signature                        | `400`                                             |
| Non-`ping` event without positive integer `installation.id` | `400`                                             |
| Installation reconciliation signal failure                  | returned status from the installation coordinator |

cyspbot does not persist a generic webhook delivery log. GitHub's app registration remains the ingress delivery log. cyspbot persists domain-specific downstream state only, such as Installation Reconciliation signals and pull request haiku queue/run records.

### Pull Request Haiku Comment Queueing

Signed `pull_request` webhook deliveries also participate in pull request haiku comment processing when all of these conditions hold:

- action is `opened`, `reopened`, `synchronize`, `edited`, or `ready_for_review`
- `repository.id`, `repository.full_name`, `pull_request.number`, and `pull_request.head.sha` are present
- the `pull-request-haiku` Flagship feature flag evaluates to enabled
- `repository.id` exists in `pull_request_haiku_repository_opt_ins`

The webhook handler evaluates the feature flag with mechanical identifiers only: installation ID, repository ID, repository full name, and pull request number. It writes queue state in D1 and sends one message to `PULL_REQUEST_HAIKU_QUEUE` only when the feature flag is enabled and the repository is opted in. The queue consumer creates or updates a single marker-owned issue comment on the pull request. The visible comment body is a generated haiku representing the pull request change.

The queue consumer reads mechanical pull request change facts and changed files from GitHub using a repository-scoped installation token with `metadata: read`, `pull_requests: write`, and `issues: write`. It does not send human-authored pull request text, such as the title or body, to the model. It does send changed filenames and aggregate change counts, so repository opt-in is required before processing private or sensitive repositories. It does not read full patches in the first implementation. The consumer skips stale queue messages when the stored current head SHA no longer matches the message head SHA.

The AI output is advisory presentation content only. It is not an authorization input and does not change Installation Token Issuance policy.

## 8. Dashboard Authentication Routes

Dashboard authentication is separate from GitHub Actions OIDC authentication.

### `GET /github/setup`

Purpose: receive GitHub App install/update setup redirects.

A recognized setup callback has:

- query parameter `installation_id` that parses to a positive safe integer
- query parameter `setup_action` equal to `install` or `update`

Recognized setup callbacks:

- do not create a dashboard session
- do not trust `installation_id` for authorization
- clear any stale `__Host-cyspbot_oauth_state` cookie
- redirect to `/login/github?return_to=%2Fdashboard`

Malformed setup callbacks return `400` problem details and clear the state cookie.

### `GET /login/github`

Purpose: start GitHub App user authorization.

The optional `return_to` query parameter is accepted only when it is:

- `/dashboard`
- `/dashboard/repositories/:owner/:name` with exactly two non-empty decoded path segments after the prefix

All other values become `/dashboard`.

The route creates a signed OAuth state cookie:

```http
Set-Cookie: __Host-cyspbot_oauth_state=<payload>.<signature>; Path=/; SameSite=Lax; HttpOnly; Max-Age=600; Secure
```

It redirects to:

```text
<github-web-base>/login/oauth/authorize?client_id=<client_id>&redirect_uri=<origin>/auth/github/callback&state=<state>
```

No OAuth scope parameter is sent.

### `GET /auth/github/callback`

Purpose: complete GitHub App user authorization.

The request must include:

- `code`
- `state`
- a valid signed `__Host-cyspbot_oauth_state` cookie
- cookie state equal to query state
- cookie state age at most 10 minutes

On success the service:

1. Exchanges the code with GitHub at `/login/oauth/access_token`.
2. Fetches the authenticated GitHub user from `/user`.
3. Upserts a dashboard user row.
4. Creates a dashboard session row.
5. Clears the OAuth state cookie.
6. Sets a dashboard session cookie.
7. Redirects to the stored return target.

Dashboard session cookie:

```http
Set-Cookie: __Host-cyspbot_dashboard_session=<opaque-token>; Path=/; SameSite=Lax; HttpOnly; Max-Age=28800; Secure
```

Invalid callbacks return `400` problem details and clear the state cookie. GitHub OAuth, user lookup, or session persistence failures return `502` problem details and clear the state cookie.

### `GET /logout`

If a dashboard session cookie is present, the service deletes the matching server-side session row. It always clears the dashboard session cookie and redirects to `/dashboard`.

## 9. Dashboard Pages

Dashboard HTML responses use:

```http
Content-Type: text/html; charset=utf-8
Cache-Control: no-store
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'
X-Frame-Options: DENY
```

The dashboard is server-rendered HTML. The browser receives only already-authorized rendered data. No browser-side API decides authorization.

### GitHub App Configuration Contract

The GitHub App is configured with distinct URLs:

- Setup URL: `<service-origin>/github/setup`
- OAuth callback URL: `<service-origin>/auth/github/callback`
- Webhook URL: `<service-origin>/github/webhooks`

For pull request haiku comments, the GitHub App installation must grant `Pull requests: write` and `Issues: write`. The consumer requests a repository-scoped installation token with those permissions plus `Metadata: read`.

The app does not rely on GitHub's "request user authorization during installation" flow for dashboard sessions. Installation setup redirects are onboarding entrypoints only; dashboard sessions are created only by the explicit state-bound `/login/github` to `/auth/github/callback` flow.

### Session Semantics

Dashboard sessions are server-side. The browser cookie contains only an opaque raw session token.

Server-side session lookup uses:

- HMAC-SHA-256 over the raw session token
- secret namespace `dashboard-session-lookup`
- `DASHBOARD_SESSION_LOOKUP_SECRET`

GitHub user access tokens are stored encrypted with AES-GCM using a key derived from:

- secret namespace `dashboard-token-encryption:v1`
- `DASHBOARD_TOKEN_ENCRYPTION_SECRET`

Session expiry:

- idle TTL: 2 hours
- absolute TTL: 8 hours
- GitHub user access token expiry, when GitHub returns one

The effective session expiry is the earliest of those timestamps. Each successful dashboard request extends idle expiry by 2 hours, subject to absolute expiry and GitHub token expiry. Expired, revoked, or undecryptable sessions are deleted and cause a login redirect with a cookie clear.

Dashboard user-wide revocation is represented by `session_revoked_after`; sessions created at or before the revocation point are invalid.

### Unauthenticated Dashboard Requests

Unauthenticated requests to `/dashboard` and repository detail pages return:

```http
HTTP/1.1 302 Found
Location: /login/github?return_to=<current-path>
```

If an invalid or expired session cookie was present, the response also clears the dashboard session cookie.

### `GET /dashboard`

Purpose: list repositories currently visible to the signed-in dashboard user for this GitHub App, with recent audit summary fields.

Read flow:

1. Validate dashboard session.
2. Call GitHub `GET /user/installations`, following pages of 100.
3. For every returned installation, call `GET /user/installations/{installation_id}/repositories`, following pages of 100.
4. Join the visible repository IDs to audit summaries from durable audit entries.
5. Render HTML.

A repository appears even when it has no audit history, as long as GitHub currently returns it for the dashboard user.

List item fields rendered:

- repository full name from GitHub
- repository visibility (`private` or `public`)
- installation ID
- last Installation Token Issuance request timestamp, if any
- last outcome, if any

Sorting:

1. active repositories before archived repositories
2. within each active/archived group, newest last issuance first
3. repositories without history after repositories with history
4. full name ascending
5. installation ID ascending

Archived repositories are rendered in a separate section. The current implementation uses request time as the archived marker for rendering; GitHub's archive timestamp is not stored.

Visible HTML contract:

- document title: `Cyspbot dashboard`
- eyebrow: `Cyspbot Dashboard`
- main heading: `Repository audit`
- signed-in copy: `Signed in as <login>.`
- sign-out link to `/logout`
- active section heading: `Active repositories`
- archived section heading: `Archived repositories`, present only when archived repositories exist
- table headings: `Repository`, `Visibility`, `Installation`, `Last issuance`, `Last outcome`
- empty table message: `No repositories are currently visible.`

If GitHub returns `401` or `403` during dashboard visibility refresh, the service deletes the session and redirects to login. Other GitHub visibility failures return `503` problem details.

### `GET /dashboard/pull-request-haikus`

Purpose: list repositories currently administered by the signed-in dashboard user and show whether pull request haiku comments are enabled.

Access is limited to repositories where GitHub reports the dashboard user has repository `admin` permission through the GitHub App user-to-server installation repository APIs. Dashboard users with no administered repositories receive `403` problem details.

Read flow:

1. Validate dashboard session.
2. Fetch the dashboard user's current GitHub installations and repositories.
3. Keep only repositories where GitHub reports repository `admin` permission.
4. Join administered repository IDs to `pull_request_haiku_repository_opt_ins`.
5. Render HTML.

### `POST /dashboard/pull-request-haikus`

Purpose: enable or disable pull request haiku comments for one administered repository.

The route accepts `application/x-www-form-urlencoded` with:

- `repository_id`
- `action` equal to `enable` or `disable`

The request must have an `Origin` header matching the request URL origin. The service validates the dashboard session, fetches repositories GitHub currently returns for the user, keeps only repositories where GitHub reports repository `admin` permission, and applies the requested toggle only when the repository ID is in that administered set.

Successful toggles redirect to `/dashboard/pull-request-haikus`.

### `GET /dashboard/repositories/:owner/:name`

Purpose: show recent Installation Token Issuance audit rows for one visible repository.

Route semantics:

- `:owner` and `:name` are URL-decoded.
- The route must have exactly two non-empty path segments after `/dashboard/repositories/`.
- The route is a current-name locator only.
- The service normalizes the requested `owner/name` by trimming and lowercasing.
- GitHub must return a repository whose normalized current full name matches.
- Previous repository names after repository rename or transfer return `404`.
- If GitHub does not return the repository for the dashboard user, return `404`.

Read flow:

1. Validate dashboard session.
2. Fetch the dashboard user's current GitHub installations and repositories.
3. Resolve the requested full name from GitHub's current response.
4. Query the last 5 audit rows by immutable repository ID.
5. Render HTML.

Detail page fields rendered:

- signed-in GitHub login
- current repository full name from GitHub
- immutable GitHub repository ID
- current visibility from GitHub
- last 5 audit rows in reverse request time

Audit row fields rendered:

- request timestamp
- audit state
- outcome
- event name
- ref
- actor
- token expiry when issuance succeeded
- permissions returned by GitHub when issuance succeeded
- outcome reason codes
- historical repository display name when it differs from current GitHub name

Repository detail pages never show token values, token hashes, raw OIDC tokens, raw webhook bodies, OAuth codes, session tokens, encrypted token blobs, or raw GitHub API responses.

Visible HTML contract:

- document title: current GitHub-returned repository full name
- eyebrow: `Cyspbot Dashboard`
- main heading: current GitHub-returned repository full name
- signed-in copy: `Signed in as <login>.`
- navigation links: `All repositories` to `/dashboard`, `Sign out` to `/logout`
- metadata section headings: `Repository`, `Repository ID`, `Visibility`
- audit section heading: `Last 5 issuance attempts`
- audit table headings: `Requested`, `State`, `Outcome`, `Event`, `Ref`, `Actor`, `Token`, `Reasons`
- empty audit table message: `No Installation Token Issuance rows are recorded for this repository.`
- if a historical audit row uses a different repository display name, render `recorded as <historical-name>` in the requested timestamp cell
- if an issued row has returned permissions, render them as comma-separated `permission=access` pairs under the token expiry

## 10. GitHub API Semantics

### Base URLs

Defaults:

- GitHub API base: `https://api.github.com`
- GitHub web base: `https://github.com`

Implementations may make these configurable for tests or local runs, but the production contract uses GitHub.

### GitHub App Authentication

The service authenticates app-level GitHub REST calls with a GitHub App JWT:

- algorithm `RS256`
- issuer `GITHUB_APP_ID`
- issued-at backdated by 60 seconds
- expiry 9 minutes after current time
- signed with the configured GitHub App private key

App and installation REST calls include:

```http
Accept: application/vnd.github+json
User-Agent: cyspbot
X-GitHub-Api-Version: 2022-11-28
```

The private key is loaded from the platform secret binding first, then from a local PEM environment variable for development and tests. The key must be PKCS#8 PEM. Imported private keys are cached in memory by PEM value.

### GitHub Error Normalization

For non-token problem-response routes:

| GitHub or local API error               | Public status |
| --------------------------------------- | ------------- |
| GitHub `400`                            | `500`         |
| GitHub `401`, `403`, `404`              | `403`         |
| GitHub `5xx`                            | `502`         |
| GitHub response shape invalid           | `502`         |
| Other GitHub status or unexpected error | `500`         |

For `/token`, the public mapping is then converted to OAuth token endpoint errors as described above.

## 11. OIDC JWKS Verification Semantics

Verification is coordinated per issuer through a logical issuer verifier. A reimplementation does not need to use Durable Objects, but it must preserve the per-issuer coordination behaviour.

Current JWKS freshness policy:

| Setting                  | Value      |
| ------------------------ | ---------- |
| default fresh window     | 5 minutes  |
| minimum fresh window     | 1 minute   |
| maximum fresh window     | 15 minutes |
| stale-while-error window | 10 minutes |
| refresh backoff base     | 5 seconds  |
| maximum backoff          | 5 minutes  |

JWKS fetching:

- `GET` the configured JWKS URI.
- Send `Accept: application/json, application/jwk-set+json`.
- Treat non-2xx responses as transport failures.
- Parse response JSON.
- Validate and normalize the complete JWKS document atomically.
- Reject empty or unusable JWKS documents.

JWK validation:

- supported key types are `RSA`, `EC`, and `OKP`
- if `use` is present, it must be `sig`
- if `key_ops` is present, it must include `verify`
- if `alg` is present, it must be one of the issuer's allowed algorithms
- RSA keys must include `n` and `e`
- EC keys must include `crv`, `x`, and `y`
- OKP keys must include `crv` and `x`

Freshness:

- If `Cache-Control: max-age=<seconds>` is present and parseable as a non-negative integer, use that value as the upstream hint.
- Clamp upstream freshness to at least the configured minimum and at most the configured maximum.
- If no valid `max-age` exists, use the configured default fresh window.
- Stale usability ends at `fresh_until + stale_while_error`.

Refresh behaviour:

- Refresh when there is no snapshot.
- Refresh when the current snapshot is not fresh.
- Refresh when a token names an unknown `kid`.
- For an unknown `kid`, make at most one guarded extra refresh attempt for that verification.
- During transport or invalid-JWKS failures, serve an existing snapshot only while it is inside its stale window.
- Apply exponential backoff after refresh failures.
- Track transport-failure and invalid-JWKS-failure counters separately.
- Reset backoff counters after a successful refresh.

Persisted verifier state contains:

- normalized JWKS snapshot
- fresh and stale timestamps
- refresh backoff state
- registration fingerprint

Changing issuer registration fingerprint invalidates incompatible persisted verifier state.

Verification uses the JWT protected header algorithm and `kid` to select candidate keys. A token without `kid` is rejected for the current GitHub Actions issuer. A token with no matching key after the allowed refresh attempt is rejected. Tokens without `kid` and more than one candidate key are rejected as ambiguous.

## 12. Durable Data Contract

Storage technology is not part of the external contract. The logical durable records and their semantics are.

All timestamps are UTC ISO 8601 strings.

### Dashboard User

Logical fields:

- immutable GitHub user ID
- display GitHub login
- last successful GitHub authorization timestamp
- optional user-wide session revocation timestamp
- created and updated timestamps

Dashboard user rows authorize only dashboard sessions. They never authorize repository visibility by themselves.

### Dashboard Session

Logical fields:

- unique HMAC lookup hash of the raw session token
- dashboard user ID
- encrypted GitHub user access token material
- optional GitHub user access token expiry
- optional GitHub refresh token expiry field, currently stored when returned but refresh is not used
- last seen timestamp
- idle expiry
- absolute expiry
- created and updated timestamps

The current implementation does not refresh GitHub user access tokens. When the token or session expires, the session is deleted and the user is redirected to login.

### Installation Token Issuance Audit Entry

A durable audit intent is written after OIDC authentication and principal normalization, before live GitHub lookup.

Logical fields:

- audit entry ID
- requested timestamp
- audit state: `pending`, `finalized`, or `finalization_failed`
- finalized timestamp
- installation ID when known
- caller repository ID from OIDC
- caller repository full name normalized
- caller repository full name display snapshot
- caller repository owner ID from OIDC, empty string when absent
- caller repository visibility from OIDC, empty string when absent
- OIDC subject
- OIDC issuer
- resolved OIDC key ID when available
- GitHub Actions event name
- GitHub ref
- GitHub ref type
- workflow ref
- job workflow ref
- run ID
- run attempt
- git SHA
- actor
- outcome: `issued`, `denied`, `upstream_error`, `internal_error`, or null while pending

Audit state and outcome are separate. `pending` means terminal processing has not been durably finalized. `finalization_failed` means the service detected failure during terminal audit persistence and could persist that marker.

Pre-authentication failures do not create audit entries because no normalized caller context exists yet.

### Audit Outcome Reason

Reason codes are stable machine strings attached to finalized audit entries when a stable reason is available. They are sorted by code for dashboard display.

Currently emitted policy reason codes:

- `policy_event_denied`
- `policy_ref_denied`
- `policy_ref_type_denied`
- `policy_repository_id_mismatch`
- `policy_repository_name_mismatch`
- `policy_repository_owner_id_mismatch`
- `policy_repository_visibility_mismatch`
- `policy_subject_mismatch`

Currently emitted GitHub/upstream/internal reason codes:

- `github_installation_not_found`
- `github_upstream_rate_limited`
- `github_upstream_unavailable`
- `github_upstream_unexpected_response`
- `internal_unexpected_error`

Audit intent write failure creates no audit entry and returns a server error. Audit finalization failure attempts to mark the original audit entry as `finalization_failed`; that marker has no guaranteed reason code.

### Issued Installation Token Fact

For a successful final token issuance, store a strict 0-or-1 child fact:

- audit entry ID
- GitHub-returned expiry timestamp

The token value is not stored. No token hash, fingerprint, or reusable token cache is stored.

### Issued Installation Token Permissions

For a successful final token issuance, store the permissions exactly as GitHub returned them:

- audit entry ID
- permission name
- permission access

The permission vocabulary belongs to GitHub. Do not force it through a local enum.

### Pull Request Haiku Repository Opt-In

Logical fields:

- GitHub repository ID
- repository full name display
- enabled timestamp
- optional enabled-by note

Only repositories that are opted in while the `pull-request-haiku` Flagship feature flag is enabled receive pull request haiku comment processing.

### Pull Request Haiku Comment State

Logical fields:

- GitHub repository ID
- pull request number
- repository full name display
- GitHub issue comment ID when known
- current head SHA
- last rendered head SHA
- updated timestamp

### Pull Request Haiku Run

Logical fields:

- GitHub delivery ID as primary idempotency key
- GitHub repository ID and display full name
- pull request number
- installation ID
- webhook action
- head SHA
- run status: `queued`, `running`, `succeeded`, `skipped`, or `failed`
- queued, started, completed, and updated timestamps
- optional GitHub issue comment ID
- optional AI model
- optional output kind
- optional error code and bounded error message

### Installation Reconciliation State

The service records reconciliation signals for installations.

Logical state row fields:

- installation ID
- reconciliation state: `idle`, `pending`, `running`, or `backoff`
- reconciliation requested flag
- last requested timestamp
- optional current run ID
- optional last successful run ID
- optional last failed run ID
- consecutive failure count
- optional next retry timestamp
- updated timestamp

On a signed non-`ping` webhook, the installation coordinator sets:

- `reconciliation_requested = true`
- `last_requested_at = now`
- `reconciliation_state = pending`, unless it was already `running`
- `updated_at = now`

In the current product, the installation coordinator persists no separate local
state. D1 is the durable source for reconciliation signal state. Audit Log,
dashboard sessions, retry counters, durable failure history, and dashboard
visibility do not live in the coordinator.

## 13. Observability and Secret Handling

The public API is deliberately terse. Detailed reasons belong in structured Worker logs and durable audit reason codes where safe.

Operational logs may include:

- coarse OIDC authentication failure reason
- issuer hint and configured issuer
- request path
- Cloudflare ray ID when present
- user agent
- GitHub API failure stage
- repository and repository ID from verified claims
- installation ID when known
- dashboard user ID during dashboard visibility failures
- error class and redacted error message

Operational logs must not include:

- raw OIDC tokens
- GitHub App private keys
- webhook secrets
- signature headers
- raw webhook bodies
- GitHub user access tokens
- installation access tokens
- OAuth codes
- OAuth state values
- dashboard session tokens
- session-token hashes
- encrypted token blobs

Issued GitHub installation access tokens are returned only to successful `/token` callers. They are never persisted for reuse.

## 14. Security Invariants

An indistinguishable implementation preserves these invariants:

1. GitHub Actions OIDC is the only caller authentication mechanism for Installation Token Issuance.
2. Issuer trust is a closed configured registry, not token-driven discovery.
3. The calling repository is derived from verified claims and never accepted as caller input.
4. GitHub App installation presence is checked live for the calling repository.
5. Token policy is checked against verified claims and live repository metadata.
6. Callers cannot choose permissions.
7. Callers cannot choose target repositories.
8. The GitHub App private key never leaves the service secret boundary.
9. Webhook input never mutates state before signature validation.
10. Dashboard repository audit data is rendered only after GitHub currently returns that repository for the dashboard user.
11. Audit persistence is mandatory for token issuance success.
12. Public responses do not disclose validation internals or secret/configuration details.

## 15. Compatibility Checks

A compatible implementation should satisfy these observable checks:

1. `GET /` returns `302` to `/dashboard` with `Cache-Control: no-store`.
2. Missing auth on `POST /github/claims` returns `401`, `WWW-Authenticate: Bearer`, and minimal problem details.
3. A verified `pull_request` caller can receive `200` from `/github/claims`.
4. Valid `/token` form exchange returns a no-store OAuth token response.
5. `/token` accepts `requested_token_type=urn:ietf:params:oauth:token-type:access_token` as a hint but still returns `issued_token_type=urn:chikachow:github-app-installation-access-token`.
6. Unsupported `requested_token_type` returns `400 {"error":"invalid_request"}`.
7. Disallowed workflow contexts return `400 {"error":"invalid_target"}` from `/token`.
8. A default-branch `workflow_dispatch` or `schedule` run can receive a token with `contents: write` and `pull_requests: write`.
9. Invalid webhook signatures return `401` problem details.
10. Webhooks whose target headers do not match the configured GitHub App return `401` problem details.
11. Signed `ping` webhooks with matching GitHub App target headers and valid JSON return `202 {"accepted":true,"event":"ping"}` without `installation.id`.
12. Non-JSON webhook content type returns `415`.
13. Webhook payloads larger than `256 KiB` return `413`.
14. Signed non-`ping` webhooks with matching GitHub App target headers and positive integer `installation.id` return `202 {"accepted":true}` and signal reconciliation.
15. `/github/setup` with recognized install/update parameters clears stale OAuth state and redirects to `/login/github?return_to=%2Fdashboard`.
16. Malformed `/github/setup` callbacks return `400` and clear stale OAuth state.
17. Unauthenticated `/dashboard` redirects to `/login/github?return_to=%2Fdashboard`.
18. Dashboard login creates signed state, validates callback state, stores a server-side session, and sets an HTTP-only secure `__Host-cyspbot_dashboard_session` cookie.
19. Dashboard list and detail pages render only repositories GitHub currently returns for the signed-in dashboard user.
20. Repository detail pages show at most the last 5 issuance attempts and never show token values.
