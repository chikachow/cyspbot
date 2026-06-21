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
- `packages/oidc` owns generic OIDC JWT verification for a configured trusted issuer.
- `packages/github-actions-oidc` owns GitHub Actions OIDC issuer constants, claim validation, and principal derivation.

The root `wrangler.jsonc` points at `test/support/root-test-harness.ts`. It is a local/test binding harness, not a deployable product Worker.

## Token Exchange Worker

`@cyspbot/token-exchange` exposes a single route:

- `POST /token`

The Worker factory is `createTokenExchangeWorker` in `workers/cyspbot-token-exchange/src/worker.ts`. Requests with any other path return problem-details `404`. Non-`POST` requests to `/token` return OAuth error JSON with `400 {"error":"invalid_request"}`.

`handleTokenExchangeRequest` in `workers/cyspbot-token-exchange/src/token-exchange.ts` implements the request flow:

1. Apply `TOKEN_EXCHANGE_RATE_LIMIT` before parsing the request body.
2. Require `application/x-www-form-urlencoded`.
3. Read at most `64 KiB`.
4. Require exactly one value for each token-exchange form parameter that cyspbot consumes.
5. Require `requested_token_type=urn:chikachow:github-app-installation-access-token`.
6. Verify the GitHub Actions OIDC subject token with the configured issuer, audience, signing algorithm, JWKS URI, and authorized-party rule.
7. Derive a GitHub Actions Principal from validated GitHub OIDC claims.
8. Evaluate token policy before GitHub API calls.
9. Resolve the GitHub App installation for the calling repository.
10. Create a metadata-only installation token and read live GitHub repository metadata.
11. Re-evaluate token policy against live repository metadata.
12. Issue a GitHub App installation access token for the calling repository id.

The token policy in `workers/cyspbot-token-exchange/src/policy/token-policy.ts` allows only `schedule` and `workflow_dispatch` runs where the verified subject and ref both identify the repository default branch. It requests these installation token permissions:

```json
{
  "contents": "write",
  "pull_requests": "write"
}
```

`issueInstallationTokenForContext` in `workers/cyspbot-token-exchange/src/policy/installation-token-issuance.ts` uses a metadata-only installation token to read live repository metadata before requesting the final installation token. The final request passes `repository_ids: [<calling repository id>]` and the checked-in permission request.

## OIDC Verification

The GitHub Actions trusted issuer is defined in `packages/github-actions-oidc/src/issuer.ts`:

- issuer: `https://token.actions.githubusercontent.com`
- audience: `cyspbot`
- JWKS URI: `https://token.actions.githubusercontent.com/.well-known/jwks`
- allowed signing algorithm: `RS256`

`packages/oidc/src/verifier.ts` verifies tokens with `jose.jwtVerify` and `jose.createRemoteJWKSet`. cyspbot keeps issuer, audience, allowed-algorithm, trusted-audience, and authorized-party checks in code. GitHub Actions claim parsing and subject interpretation live in `packages/github-actions-oidc/src/github-actions-principal.ts`.

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
- [GitHub Actions OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [GitHub Actions OIDC security hardening](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [GitHub App installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Cloudflare Workers Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
