# cyspbot Service Contract

This document describes the public interface, security boundaries, and externally observable behaviour implemented by cyspbot.

## Public Endpoints

| Route              | Method | Purpose                                     | Success response           |
| ------------------ | ------ | ------------------------------------------- | -------------------------- |
| `/token`           | `POST` | Exchange trusted GitHub Actions OIDC tokens | OAuth token response JSON  |
| `/github/webhooks` | `POST` | Accept signed GitHub App webhook deliveries | `202` acknowledgement JSON |

Unknown routes return `404` problem details. Unsupported methods on `/github/webhooks` return `405` problem details with `Allow: POST`. Unsupported methods on `/token` return OAuth error JSON with `400 {"error":"invalid_request"}`.

## Token Exchange

`POST /token` accepts `application/x-www-form-urlencoded` token exchange input aligned with [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693):

- `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
- `subject_token=<github-actions-oidc-token>`
- `subject_token_type=urn:ietf:params:oauth:token-type:id_token` or `urn:ietf:params:oauth:token-type:jwt`
- optional `requested_token_type` of `urn:chikachow:github-app-installation-access-token` or `urn:ietf:params:oauth:token-type:access_token`

Request bodies are bounded to `64 KiB`.

Requests are rate limited by the `TOKEN_EXCHANGE_RATE_LIMIT` Cloudflare binding before the body is parsed.

Successful responses are JSON with `Cache-Control: no-store` and `Pragma: no-cache`:

```json
{
  "access_token": "ghs_...",
  "issued_token_type": "urn:chikachow:github-app-installation-access-token",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

OAuth error responses use JSON with the same no-store headers:

- malformed request: `400 {"error":"invalid_request"}`
- unsupported grant type: `400 {"error":"unsupported_grant_type"}`
- rate limit exceeded: `429 {"error":"temporarily_unavailable"}`
- body too large: `413 {"error":"invalid_request"}`
- policy denial: `400 {"error":"invalid_target"}`
- upstream GitHub server failure: `502 {"error":"server_error"}`
- internal server failure: `500 {"error":"server_error"}`

### Token Policy

Installation Token Issuance is allowed only when all implemented checks pass:

- the caller is a verified [GitHub Actions OIDC](https://docs.github.com/en/actions/concepts/security/openid-connect) principal from `https://token.actions.githubusercontent.com`
- the OIDC token audience is `cyspbot`
- if the OIDC token has an `azp` claim, that claim is also `cyspbot`
- `event_name` is `schedule` or `workflow_dispatch`
- the OIDC subject context is `ref`
- `sub` and `ref` both identify the repository's current default branch ref
- `ref_type` is `branch`
- `repository`, `repository_id`, `repository_owner_id`, and `repository_visibility` match live GitHub repository metadata

The caller cannot choose a repository or permission profile. cyspbot issues only for the Calling Repository derived from verified OIDC claims. The [GitHub App installation](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app) remains the upper-bound permission authority.

The checked-in permission request for the issued Installation Token is:

```json
{
  "contents": "write",
  "pull_requests": "write"
}
```

cyspbot denies `push`, `pull_request`, `pull_request_target`, forked pull request contexts, non-default-branch refs, tag refs, and unsupported event names.

## GitHub Webhook Receiver

`POST /github/webhooks` accepts signed GitHub App webhook deliveries and acknowledges valid signed JSON events without retaining raw payloads or running event-specific product logic. Signature verification follows GitHub's `X-Hub-Signature-256` webhook signing model.

Required request properties:

- `Content-Type` primary media type is `application/json`
- body is at most `256 KiB`
- `X-GitHub-Event` is present
- `X-GitHub-Delivery` is present
- `X-Hub-Signature-256` is present and matches `sha256=<64 lowercase hex chars>`
- `X-GitHub-Hook-Installation-Target-Type` is `integration`
- `X-GitHub-Hook-Installation-Target-ID` equals configured `GITHUB_APP_ID`
- body parses as JSON after signature verification

Responses:

- valid signed `ping`: `202 {"accepted":true,"event":"ping"}`
- any other valid signed JSON event: `202 {"accepted":true}`
- malformed JSON after authentication: `400` problem details
- missing GitHub event, delivery, or signature header: `400` problem details
- missing or wrong target app headers: `401` problem details
- malformed or invalid signature: `401` problem details
- body too large: `413` problem details
- non-JSON content type: `415` problem details
- missing webhook secret configuration: `500` problem details

The receiver verifies the exact request bytes read through the bounded request-body reader. It does not store delivery ids, raw bodies, or parsed event payloads.

## Runtime Bindings

The implementation uses these runtime bindings:

- `GITHUB_APP_ID`
- `GITHUB_WEBHOOK_SECRET` Secrets Store binding or Worker secret
- `GITHUB_APP_PRIVATE_KEY` Secrets Store binding or Worker secret
- `TOKEN_EXCHANGE_RATE_LIMIT` Cloudflare rate-limit binding

The public Wrangler configs declare binding names for local development, tests, and dry-runs. `GITHUB_API_BASE_URL` is optional for the token exchange Worker and defaults to `https://api.github.com`.

## Unsupported Behaviour

cyspbot does not implement:

- caller-selected repositories
- caller-selected GitHub permission profiles
- dynamic issuer discovery from untrusted tokens
- raw webhook payload archival or replay
- product-specific webhook event processing
- issued Installation Token caching

## External References

- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [GitHub Actions OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [GitHub App installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
