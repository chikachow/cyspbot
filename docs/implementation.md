# Implementation

This document describes the code and runtime shape in this repository.
Externally observable API behaviour is specified in [service-contract.md](service-contract.md).

## Workspace Layout

cyspbot is a pnpm workspace with deployable Cloudflare Worker packages under `workers/*` and shared implementation packages under `packages/*`.

Deployable Workers:

- `workers/cyspbot-token-exchange` publishes package `@cyspbot/token-exchange` and Worker `cyspbot-token-exchange`.
- `workers/cyspbot-github-webhook-receiver` publishes package `@cyspbot/github-webhook-receiver` and Worker `cyspbot-github-webhook-receiver`.

Shared packages:

- `packages/http` owns framework-free JSON responses, problem details, and bounded request-body reading.
- `packages/github` owns GitHub App JWT signing, GitHub REST calls, installation lookup, installation token creation, and secret binding resolution.
- `packages/oidc` owns OpenID Connect ID Token verification and the issuer-adapter contract.
- `packages/oidc-issuer-github-actions` owns the GitHub Actions issuer adapter and trusted issuer constants.

The root `wrangler.jsonc` points at `test/support/root-test-harness.ts`. It is a local/test binding harness, not a deployable product Worker.

## Token Exchange Worker

`@cyspbot/token-exchange` exposes a single route:

- `POST /token`

The Worker factory is `createTokenExchangeWorker` in `workers/cyspbot-token-exchange/src/worker.ts`. It constructs a request-scoped `TokenExchangeRequestRuntime` from Worker bindings and infrastructure dependencies, then passes that narrow runtime to the request handler. Requests with any other path return problem-details `404`. Non-`POST` requests to `/token` return OAuth error JSON with `400 {"error":"invalid_request"}`.

`handleTokenExchangeRequest` in `workers/cyspbot-token-exchange/src/token-exchange.ts` implements the request flow without direct access to Cloudflare bindings. The runtime supplies rate limiting, subject-token authentication, installation-token issuance, and the current time:

1. Apply `TOKEN_EXCHANGE_RATE_LIMIT` before parsing the request body.
2. Require `application/x-www-form-urlencoded`.
3. Read at most `64 KiB`.
4. Require exactly one non-empty value for each required token-exchange form parameter that cyspbot consumes; value-less instances are treated as omitted, and duplicated non-empty consumed parameters are malformed.
5. Require `subject_token_type=urn:ietf:params:oauth:token-type:id_token` and `requested_token_type=urn:chikachow:github-app-installation-access-token`; reject the generic JWT subject-token type.
6. Treat exactly empty optional `scope` and `resource` form values as omitted, and preserve non-empty values for normalization after authentication.
7. Reject unsupported or ambiguous fields, including non-empty RFC 8693 `audience`, malformed `scope` or `resource`, duplicate consumed fields, actor-token fields, and multi-resource forms. Non-empty `audience` maps to `invalid_target`; actor-token parameters map to `invalid_request`.
8. Select a configured issuer adapter from the token's unverified `iss` claim, verify the subject token with that adapter's trusted issuer, signing algorithm, and JWKS URI, then validate that the verified token `aud` claim is the internal service audience `cyspbot` and apply provider-specific subject binding. Unconfigured issuers are rejected before any JWKS fetch.
9. Retain the verified subject-token claims, issuer, resolved key ID, and declared subject-token type as the authenticated context.
10. Normalize an `InstallationAccessTokenRequest` from `scope` and `resource`.
11. Evaluate static Token Policy over `{ subjectToken, tokenRequest }`.
12. Resolve the target GitHub App installation from the normalized repository resource using cyspbot's configured GitHub App credentials.
13. Issue a GitHub App installation access token for `repositories: [<repo>]` and the normalized permissions.

The token policy in `workers/cyspbot-token-exchange/src/policy/token-policy.ts` normalizes and authorizes token requests and matches each allow rule's verified subject-token issuer, GitHub repository resource, and permission set. `workers/cyspbot-token-exchange/src/policy/token-policy-condition.ts` uses the CEL library to compile, cache, bind, and evaluate each rule's bounded condition. CEL errors, absent or unknown claims, type mismatches, and non-boolean results fail closed. `workers/cyspbot-token-exchange/src/policy/github-actions-token-policy-rule.ts` owns the GitHub Actions claim and subject condition shared by production policy and tests. Policy does not mutate the requested token shape. The current policy data lives in `workers/cyspbot-token-exchange/src/policy/token-policy-rules.ts`, but exact entries are service-owned authorization data rather than implementation documentation.

cyspbot does not accept a public GitHub App selector. It constrains this profile to cyspbot's configured GitHub App credentials, one signed subject-token `aud` string equal to `cyspbot`, one canonical GitHub repository API `resource`, and one normalized permission set. Plural subject-token audiences are rejected rather than interpreted by containment.

### Shared request normalization

An omitted `scope` normalizes to a PR-authoring permission request.

```json
{
  "contents": "write",
  "pull_requests": "write"
}
```

### Issuer-specific normalization and authorization

#### GitHub Actions

For GitHub Actions, an omitted `resource` defaults to the repository named by the Verified Subject Token's signed `repository` claim. Omitting both `scope` and `resource` produces the permission request shown above.

That token request is allowed only when an issuer-guarded rule's CEL condition matches the signed GitHub Actions `repository`, event, `ref`, `sub`, and exact `workflow_ref` claims and the rule's canonical resource URI and permissions match the normalized request. The condition accepts the expected legacy GitHub subject or its immutable owner/repository-ID form; inconsistent names or IDs therefore do not match. Rule order is not semantically meaningful; authorization is `allow` if any rule matches and `deny` otherwise. Exact policy entries are intentionally not documented here because they may move to live configuration.

Repository identity in Token Policy is intentionally name-based. GitHub Actions OIDC exposes `repository_id` and `repository_owner_id` as signed claims, immutable subject formats can include those IDs in `sub`, and GitHub's installation-token API supports `repository_ids`; cyspbot still chooses owner/repository names as the policy identifier because they are the maintained external resource names and because token issuance still requires the configured GitHub App installation to cover that repository name. Legacy subjects therefore do not require ID claims. Immutable subjects require `repository_id` to agree with `sub`; the optional `repository_owner_id` claim is checked only when present and non-null. These IDs reject internal inconsistencies but are not independent policy keys. If a repository is deleted and recreated with the same owner/name, matching existing policy for that name is accepted behavior rather than a bypass. GitHub subject strings are compared literally rather than percent-decoding repository or ref components.

### Shared enforcement and issuance

ID Token verification and issuer-specific subject binding authenticate the signed claim set, while Token Policy decides which claims matter for a particular grant. Missing or incorrectly typed claims named by a condition fail closed as `invalid_target`; policy-irrelevant metadata does not affect authorization. An invalid standard ID Token claim or failed issuer-specific subject binding causes authentication to fail as `invalid_request`.

`issueInstallationTokenForContext` in `workers/cyspbot-token-exchange/src/policy/installation-token-issuance.ts` does not fetch source repository metadata. It parses the normalized token resource as `https://api.github.com/repos/{owner}/{repo}`, resolves the target installation with `GET /repos/{owner}/{repo}/installation`, then passes `repositories: ["<repo>"]` and the normalized permissions to GitHub's installation-token endpoint.

cyspbot treats exactly empty optional `scope` and `resource` form values as omitted to follow OAuth token endpoint parameter handling for those fields. It does not translate `scope=` into `permissions: {}`. GitHub documents that omitting `permissions` defaults to the app installation's granted permissions, and live testing showed that a present empty `permissions: {}` object receives the same default permission set. Minimal-permission token shapes must be expressed as explicit non-empty scopes such as `contents:read`. Scope values are parsed as OAuth scope tokens separated by a single ASCII space; order is not significant, but leading whitespace, trailing whitespace, repeated spaces, tabs, and newlines are rejected. The normalized token request retains a canonical scope string, and `/token` success responses always include that issued scope so clients can observe defaults and normalized ordering.

cyspbot does not support OAuth client authentication at `/token`. Non-empty `client_id`, `client_secret`, `client_assertion`, and `client_assertion_type` form parameters are rejected with `invalid_request` so callers cannot mistakenly believe client credentials affected token issuance. Value-less form parameters are treated as omitted. An `Authorization` header is rejected with `invalid_client` and `401` before body parsing. Non-empty `authorization_details` is also rejected because this profile expresses the token shape only through cyspbot's service app, `resource`, and `scope`.

## ID Token Verification

`packages/oidc/src/verifier.ts` exposes `OidcIdTokenVerifier`, which verifies ID Tokens with `jose.jwtVerify` and `jose.createRemoteJWKSet`. The verifier owns issuer, allowed-algorithm, signature, expiry, and JWKS checks and requires a semantically valid `iss`, `aud`, `sub`, `exp`, and `iat` claim set before returning `VerifiedOidcIdToken`. It accepts string and plural audiences at this package boundary and does not impose a maximum token age; token-exchange authentication separately requires the exact single audience string `cyspbot`. `packages/oidc/src/issuer-adapter.ts` defines how authentication recognizes a configured issuer and applies provider-specific subject-token binding to the complete centrally verified ID Token. Token-exchange authentication selects only from adapters composed in `workers/cyspbot-token-exchange/src/oidc-issuers.ts`; the unverified `iss` claim selects configured trust material but never supplies a JWKS URI.

### Supported issuer adapters

| Issuer adapter | Trusted Issuer (`iss`)                        | JWKS URI                                                       | Algorithm |
| -------------- | --------------------------------------------- | -------------------------------------------------------------- | --------- |
| GitHub Actions | `https://token.actions.githubusercontent.com` | `https://token.actions.githubusercontent.com/.well-known/jwks` | `RS256`   |

#### GitHub Actions

The shared verifier requires the standard ID Token claims. The GitHub Actions adapter additionally accepts an absent Authorized Party (`azp`) claim and requires it to equal the expected audience `cyspbot` when present.

OIDC/JWKS failures are classified at the verifier boundary:

- Provider failure: network failures, timeouts, non-200 JWKS responses, malformed JWKS JSON, malformed JWKS shape, and ambiguous JWKS key matches. In these cases cyspbot could not obtain a usable trusted key set, so `/token` returns `503 {"error":"temporarily_unavailable"}`.
- Invalid subject token: JWT/JWS/claim validation failures, including a JWT header `kid` absent from the usable JWKS. The caller controls the `kid` header, and a valid JWKS that lacks the requested key is not evidence of provider unavailability. `/token` returns `400 {"error":"invalid_request"}`.

## Webhook Receiver Worker

`@cyspbot/github-webhook-receiver` exposes a single route:

- `POST /github/webhooks`

The Worker factory is `createGitHubWebhookReceiverWorker` in `workers/cyspbot-github-webhook-receiver/src/worker.ts`. Requests with any other path return problem-details `404`. Non-`POST` requests to `/github/webhooks` return problem-details `405` with `Allow: POST`.

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

That command validates the lockfile, formatting, generated Wrangler bindings, lint, TypeScript, Knip, Vitest, and Worker dry-runs.

The public GitHub Actions `ci` workflow runs the same classes of checks as separate reusable jobs and gates on an aggregate `ci` job.

## External References

- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [OpenID Connect Core 1.0: ID Token validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
- [GitHub Actions OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [GitHub Actions OIDC security hardening](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [GitHub App installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Cloudflare Workers Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
