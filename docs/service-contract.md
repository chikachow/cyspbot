# cyspbot Service Contract

This document describes the public interface, security boundaries, and externally observable behaviour implemented by cyspbot.

## Public Endpoints

| Route              | Method | Purpose                                     | Success response           |
| ------------------ | ------ | ------------------------------------------- | -------------------------- |
| `/token`           | `POST` | Exchange trusted OIDC tokens                | OAuth token response JSON  |
| `/github/webhooks` | `POST` | Accept signed GitHub App webhook deliveries | `202` acknowledgement JSON |

Unknown routes return `404` problem details. Unsupported methods on `/github/webhooks` return `405` problem details with `Allow: POST`. Unsupported methods on `/token` return OAuth error JSON with `400 {"error":"invalid_request"}`.

## Token Exchange

`POST /token` accepts `application/x-www-form-urlencoded` token exchange input aligned with [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693):

- `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
- `subject_token=<github-actions-oidc-token>`
- `subject_token_type=urn:ietf:params:oauth:token-type:id_token` or `urn:ietf:params:oauth:token-type:jwt`
- `requested_token_type=urn:chikachow:github-app-installation-access-token`
- optional `scope=<github-permission-request-list>`
- optional `resource=<canonical-github-repository-api-uri>`

Request bodies are bounded to `64 KiB`.

Requests are rate limited by the `TOKEN_EXCHANGE_RATE_LIMIT` Cloudflare binding before the body is parsed.

`resource`, when present, must be exactly one canonical GitHub repository API URI:

```text
https://api.github.com/repos/{owner}/{repo}
```

Repository shorthand, GitHub HTML URLs, endpoint URLs, duplicate resource fields, query strings, fragments, userinfo, encoded slashes, dot segments, leading or trailing whitespace, arrays, and multi-resource forms are rejected. When `resource` is omitted or exactly empty, cyspbot normalizes it to the verified GitHub Actions subject token's signed repository claim. A whitespace-only `resource` field is rejected as `invalid_target`; omission and `resource=` are equivalent.

`scope`, when present, is a single-ASCII-space-delimited list of exact GitHub App permission requests, such as `actions:read`, `actions:write`, or `contents:read pull_requests:read`. Scope order is not significant, but leading whitespace, trailing whitespace, repeated spaces, tabs, newlines, and other non-`0x20` separators are rejected. When `scope` is omitted or exactly empty, cyspbot normalizes it to `contents:write pull_requests:write`. A whitespace-only `scope` field is rejected as `invalid_scope`; omission and `scope=` are equivalent.

An empty `scope` is not a no-permissions request. Following OAuth token endpoint parameter handling for this optional field, `scope=` is treated as omitted and receives the cyspbot default scope. GitHub documents that an omitted installation-token `permissions` object receives the app installation's granted permissions, and live testing showed that a present empty `permissions: {}` object receives the same default permissions. cyspbot therefore never translates an empty scope to an empty GitHub permissions object.

The GitHub Actions OIDC subject token's `aud` claim must be the internal service audience `cyspbot`. cyspbot rejects missing `aud`, plural `aud`, and any other `aud` value as invalid subject tokens with `400 {"error":"invalid_request"}`. If the subject token has an `azp` claim, cyspbot accepts it only when it also matches `cyspbot`.

cyspbot does not support RFC 8693 `audience`, `actor_token`, or `actor_token_type` form parameters. Non-empty `audience` parameters are rejected with `invalid_target` because this profile uses `resource` for the issued token target and service-owned GitHub App credentials. Actor-token parameters are rejected as malformed for this profile with `invalid_request`.

cyspbot also does not support OAuth client authentication or Rich Authorization Requests at `/token`. Requests containing non-empty `client_id`, `client_secret`, `client_assertion`, `client_assertion_type`, or `authorization_details` fields are rejected with `invalid_request` rather than silently ignored. Requests containing an `Authorization` header are rejected with `401 {"error":"invalid_client"}` and a matching `WWW-Authenticate` challenge. Value-less form parameters are treated as omitted, and other unrecognized extension parameters are ignored, according to OAuth token endpoint rules.

The signed subject token proves it was minted for cyspbot as the relying service; the service owns the GitHub App credential profile; `resource` names the GitHub API repository target where the issued token will be used; and Token Policy decides whether that verified principal may receive the requested installation token. Plural subject-token audiences are rejected rather than interpreted by containment.

Policy denial for a supported, normalized GitHub App and `resource` receives `400 {"error":"invalid_target"}`.

Successful responses are JSON with `Cache-Control: no-store` and `Pragma: no-cache`. cyspbot always returns the canonical issued `scope`, including when the request omitted `scope`, sent `scope=`, or supplied the same permission set in a different order:

```json
{
  "access_token": "ghs_...",
  "issued_token_type": "urn:chikachow:github-app-installation-access-token",
  "token_type": "Bearer",
  "scope": "contents:write pull_requests:write",
  "expires_in": 3600
}
```

OAuth error responses use JSON with the same no-store headers:

- malformed request: `400 {"error":"invalid_request"}`
- unsupported client authentication header: `401 {"error":"invalid_client"}`
- missing or unsupported requested token type: `400 {"error":"invalid_request"}`
- unsupported non-empty token-exchange `audience`: `400 {"error":"invalid_target"}`
- unsupported grant type: `400 {"error":"unsupported_grant_type"}`
- rate limit exceeded: `429 {"error":"temporarily_unavailable"}`
- body too large: `413 {"error":"invalid_request"}`
- OIDC/JWKS provider unavailable: `503 {"error":"temporarily_unavailable"}`
- unsupported target selector or policy denial: `400 {"error":"invalid_target"}`
- upstream GitHub server failure: `502 {"error":"server_error"}`
- internal server failure: `500 {"error":"server_error"}`

OIDC/JWKS provider unavailability means cyspbot cannot obtain a usable trusted key set: JWKS network failures, timeouts, non-200 responses, malformed JSON, malformed shape, or ambiguous key matches. OIDC tokens whose JWT header names a `kid` absent from the usable JWKS are invalid subject tokens and return `400 {"error":"invalid_request"}` because the caller controls the `kid` header.

### Token Policy

Installation Token Issuance is allowed only when the normalized installation token request matches an explicit checked-in Token Policy rule. Each rule binds a verified subject-token issuer, exact resource and permissions, and a fail-closed CEL condition over signed `claims`, `subject`, and normalized `request` data:

- the caller presents a verified [GitHub Actions OIDC](https://docs.github.com/en/actions/concepts/security/openid-connect) subject token from `https://token.actions.githubusercontent.com`
- the signed subject token audience is `cyspbot`
- if the OIDC token has an `azp` claim, that claim matches `cyspbot`
- `event_name` is listed by the matching rule
- `ref_type` is `branch`
- `sub` is either the expected legacy repository/ref form or an immutable form consistent with the signed repository ID and, when present, owner ID claim
- `repository`, `ref`, `sub`, and `workflow_ref` exactly satisfy the matching rule's CEL condition
- normalized `resource` and `permissions` exactly match the matching rule

Fly.io Machine tokens may authenticate only from organization issuers explicitly configured by the service. Authentication requires non-empty immutable organization, app, and Machine identity claims; `org_name` must match the configured issuer slug; and `sub` must equal `org_name:app_name:machine_name`. They remain denied unless an issuer-guarded Token Policy rule also matches immutable organization and app IDs, an optional Machine ID, the resource, and requested permissions.

The caller cannot supply arbitrary GitHub Apps, GitHub permissions, or repository ids. The validated `scope` and validated `resource` are normalized into one installation token request. Token Policy answers whether the verified subject token may receive exactly that token request, including cross-owner requests when explicit policy allows them. cyspbot denies unconfigured issuer/condition/resource/permission combinations with `invalid_target`. The [GitHub App installation](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app) remains the upper-bound permission authority.

Policy evaluates only facts present in the verified token. For the common legacy subject form, the rule requires `sub` to contain the same repository name as the signed `repository` claim; `repository_id` and `repository_owner_id` are not inputs to that authorization decision. For GitHub's immutable subject form, `repository_id` must be present and consistent with `sub`. When the optional `repository_owner_id` claim is present, it must also be a string consistent with `sub`; when it is absent or null, policy accepts any owner ID embedded in the otherwise matching immutable subject. These IDs check internal subject consistency but are not independent policy keys.

Missing or incorrectly typed claims used by a configured policy condition authenticate as verified token data but fail policy with `400 {"error":"invalid_target"}`. Claims that the matching rule does not use, such as GitHub's `actor` metadata, do not affect authorization. Invalid issuer, signature, audience, expiry, `azp`, or subject binding remains an invalid subject token and returns `400 {"error":"invalid_request"}`. Subject matching is literal; percent-encoded repository or ref components are not decoded into an allowed subject.

Token Policy intentionally uses GitHub owner/repository names as the externally meaningful repository identifier, even though [GitHub Actions OIDC](https://docs.github.com/en/actions/reference/security/oidc) also exposes immutable repository and owner IDs and GitHub's installation-token API can scope by `repository_ids`. Those IDs participate in the immutable-subject consistency condition but are not independent policy keys. A repository that is deleted and recreated with the same owner/name can continue to match policy for that name when the GitHub App installation still grants sufficient permissions.

The omitted `scope` and `resource` default produces this normalized permission request for cyspbot's service-owned GitHub App and the verified principal repository:

```json
{
  "contents": "write",
  "pull_requests": "write"
}
```

That token request is allowed only when explicit service-owned policy allows it. The exact policy entries are intentionally not part of this public contract because the policy data may move from checked-in code to live configuration.

cyspbot resolves the target installation with `GET /repos/{owner}/{repo}/installation`, then mints the final installation token with GitHub's `repositories` selector and the normalized permissions. It does not fetch source repository metadata, compare OIDC repository claims to live source repository metadata, or use live default-branch metadata as policy criteria.

cyspbot denies forked pull request contexts, unconfigured refs, unconfigured workflow files, tag refs, unsupported event names, unsupported scopes, and non-canonical resource forms.

### Standards and Vendor References

- [RFC 8693, Section 2.1](https://www.rfc-editor.org/rfc/rfc8693#section-2.1): token exchange request parameters, including `resource`, `audience`, `scope`, `subject_token`, `subject_token_type`, `actor_token`, `actor_token_type`, and `requested_token_type`.
- [RFC 8693, Section 2.2.1](https://www.rfc-editor.org/rfc/rfc8693#section-2.2.1): successful token exchange responses, including the requirement to return `scope` when the issued token scope differs from the requested scope.
- [RFC 8693, Section 2.2.2](https://www.rfc-editor.org/rfc/rfc8693#section-2.2.2): `invalid_target` for unsupported requested resources or audiences.
- [RFC 6749, Section 3.2](https://www.rfc-editor.org/rfc/rfc6749#section-3.2): token endpoint request parameter handling, including value-less parameters, duplicate parameters, unrecognized parameters, and client authentication.
- [RFC 6749, Section 3.3](https://www.rfc-editor.org/rfc/rfc6749#section-3.3): OAuth scope syntax and authorization-server-defined scope strings.
- [RFC 6749, Section 4.5](https://www.rfc-editor.org/rfc/rfc6749#section-4.5): extension grant types can define additional token endpoint parameters.
- [RFC 6749, Section 5.1](https://www.rfc-editor.org/rfc/rfc6749#section-5.1): successful token responses, including `scope` response semantics.
- [RFC 6749, Section 5.2](https://www.rfc-editor.org/rfc/rfc6749#section-5.2): OAuth token endpoint error responses, including `invalid_client` and `WWW-Authenticate` handling for authorization-header client authentication attempts.
- [RFC 6749, Section 8.2](https://www.rfc-editor.org/rfc/rfc6749#section-8.2): registration requirements for new OAuth endpoint parameters.
- [RFC 7523, Section 2.2](https://www.rfc-editor.org/rfc/rfc7523#section-2.2): JWT bearer client authentication parameters `client_assertion` and `client_assertion_type`.
- [RFC 9396](https://www.rfc-editor.org/rfc/rfc9396): Rich Authorization Requests and the `authorization_details` parameter.
- [RFC 7519, Section 4.1.3](https://www.rfc-editor.org/rfc/rfc7519#section-4.1.3): JWT `aud` claim processing and rejection when the processor is not an intended audience.
- [OpenID Connect Core 1.0, Section 3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation): ID Token audience and authorized-party validation.
- [GitHub Actions OIDC reference](https://docs.github.com/en/actions/reference/security/oidc): GitHub Actions OIDC claims, including `aud`, `repository`, `repository_id`, `repository_owner_id`, and `workflow_ref`.
- [GitHub App installation access token API](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app): GitHub installation tokens are narrowed with `repositories` or `repository_ids` and `permissions`, subject to the app installation's grants.

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
- `FLY_OIDC_ORG_SLUGS`
- `GITHUB_WEBHOOK_SECRET` Secrets Store binding or Worker secret
- `GITHUB_APP_PRIVATE_KEY` Secrets Store binding or Worker secret
- `TOKEN_EXCHANGE_RATE_LIMIT` Cloudflare rate-limit binding

The public Wrangler configs declare binding names for local development, tests, and dry-runs. `GITHUB_API_BASE_URL` is optional for the token exchange Worker and defaults to `https://api.github.com`.

## Unsupported Behaviour

cyspbot does not implement:

- caller-selected arbitrary repositories
- caller-supplied raw GitHub permissions
- caller-defined GitHub permission profiles or aliases
- multi-audience subject tokens or multi-resource token requests
- dynamic issuer discovery from untrusted tokens
- raw webhook payload archival or replay
- product-specific webhook event processing
- issued Installation Token caching

## External References

- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [GitHub Actions OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [GitHub App installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
