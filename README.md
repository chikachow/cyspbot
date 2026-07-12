# cyspbot

cyspbot is a hosted Security Token Service for GitHub Actions workflows. It verifies GitHub Actions OIDC tokens from the configured issuer and exchanges allowed workflow contexts for short-lived, repository-scoped GitHub App installation access tokens without exposing the GitHub App private key outside Cloudflare.

Implemented public endpoints:

- `POST /token` exchanges a trusted GitHub Actions OIDC token for a scoped GitHub App installation access token.
- `POST /github/webhooks` accepts signed GitHub App webhook deliveries and acknowledges them without retaining raw payloads or running downstream product logic.

The primary service contract is [docs/service-contract.md](docs/service-contract.md). The implementation reference is [docs/implementation.md](docs/implementation.md). The documentation map is [docs/README.md](docs/README.md).

## Implemented Architecture

- Two deployable Worker packages under `workers/*`: `@cyspbot/token-exchange` and `@cyspbot/github-webhook-receiver`.
- Worker names are consistently prefixed: `cyspbot-token-exchange` and `cyspbot-github-webhook-receiver`.
- Each Worker package owns its runtime composition, HTTP route, dependency defaults, and Wrangler config. Shared implementation code lives under `packages/*`. The root Wrangler config is only the local/test binding harness.
- `jose`-backed OIDC verification for the GitHub Actions issuer, with GitHub Actions claim parsing as a separate provider layer.
- GitHub App private key in a Cloudflare Worker secret binding.
- Checked-in Token Policy code that allows Installation Token Issuance only for explicit verified subject-token issuer, CEL claim condition, resource, and permission combinations.

## Current Public Surface

### `POST /token`

Primary endpoint for Installation Token Issuance. It accepts `application/x-www-form-urlencoded` OAuth token exchange input:

```http
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
requested_token_type=urn:chikachow:github-app-installation-access-token
subject_token=<github-actions-oidc-token>
subject_token_type=urn:ietf:params:oauth:token-type:id_token
```

`subject_token_type` may also be `urn:ietf:params:oauth:token-type:jwt`. `requested_token_type` is required and must be the cyspbot GitHub App installation token URN.
Every OIDC ID Token supplied as the RFC 8693 subject token must be signed by a configured issuer, unexpired, and have the single audience (`aud`) value `cyspbot`. The selected issuer adapter then applies its provider-specific subject binding before Token Policy evaluates the request. Non-empty RFC 8693 `audience` form parameters are rejected as unsupported target selectors.

Requests may include RFC 8693 `scope` and `resource` fields to request a concrete GitHub App installation token shape. `resource` must be one canonical GitHub repository API URI in the form `https://api.github.com/repos/{owner}/{repo}` with no leading or trailing whitespace. `scope` is a single-ASCII-space-delimited list of exact GitHub App permission requests, such as `actions:read`, `actions:write`, or `contents:read pull_requests:read`; scope order is not significant. Omitted or exactly empty `scope` defaults to `contents:write pull_requests:write`. Whitespace-only, padded, duplicate, or multi-value `scope` and `resource` fields are rejected.

#### GitHub Actions caller

GitHub Actions OIDC ID Tokens are issued by `https://token.actions.githubusercontent.com`. An absent Authorized Party (`azp`) claim is accepted; when present, it must equal `cyspbot`. An omitted or exactly empty `resource` defaults to the token's signed `repository` claim. Authentication does not create a grant: Token Policy must still match the signed workflow identity, repository resource, and exact permissions.

Empty `scope` is not a no-permissions request. Following OAuth token endpoint parameter handling for this optional field, `scope=` is treated as omitted and receives the cyspbot default scope. GitHub's installation-token API treats an omitted `permissions` object as the app installation's default permissions, and live testing showed that a present empty `permissions: {}` object receives the same default permissions. cyspbot therefore requires a non-empty explicit scope when the caller does not want the cyspbot default.

OAuth client authentication is not supported at `/token`. Requests with an `Authorization` header or non-empty client-authentication form parameters are rejected rather than silently ignored.

Successful responses use OAuth token response shape with `Cache-Control: no-store` and `Pragma: no-cache`. The response always includes the canonical issued `scope`, so callers can observe defaults and normalized ordering:

```json
{
  "access_token": "ghs_...",
  "issued_token_type": "urn:chikachow:github-app-installation-access-token",
  "token_type": "Bearer",
  "scope": "contents:write pull_requests:write",
  "expires_in": 3600
}
```

### `POST /github/webhooks`

Accepts signed JSON GitHub App webhook deliveries up to `256 KiB`. Webhook target headers must identify the configured GitHub App. Raw webhook bodies are not retained.

Signed `ping` deliveries return `202 {"accepted":true,"event":"ping"}`. Any other valid signed JSON event returns `202 {"accepted":true}` with no event-specific parsing or downstream work.

## Current Token Policy

Installation Token Issuance is allowed only when a normalized token request matches an explicit checked-in Token Policy rule. Rules bind the verified subject-token issuer, exact resource and permissions, and a CEL condition over signed `claims`, `subject`, and normalized `request` data.

### GitHub Actions

- the caller is a verified GitHub Actions principal from the configured issuer
- the signed subject token audience is `cyspbot`, and any `azp` claim is accepted only if it also matches `cyspbot`
- `event_name` matches the checked-in rule
- the OIDC subject context is `ref`
- `ref` and the parsed subject ref exactly match the checked-in rule
- the parsed subject repository name matches the signed `repository` claim, and immutable subject IDs are checked when GitHub includes them in `sub`
- `workflow_ref` exactly matches the checked-in rule
- `ref_type` is `branch`
- the normalized token request `resource` and `permissions` exactly match the checked-in rule

Repository identity in policy is intentionally based on GitHub owner/repository names rather than repository IDs. GitHub Actions OIDC tokens may carry repository IDs as separate signed claims, and immutable subject formats may repeat those IDs inside `sub`; the CEL condition requires the immutable `sub` IDs to agree with the corresponding signed claims, but policy matching itself remains name-based. A repository that is deleted and recreated with the same owner/name can match existing policy for that name, and token issuance still depends on the GitHub App being installed with sufficient permissions.

### Enforcement

The caller cannot supply arbitrary GitHub Apps, GitHub permissions, or repository ids. The validated `scope` and validated `resource` are normalized into one installation token request, then policy answers whether the verified subject token may receive exactly that token. Cross-owner requests are possible only when explicitly allowed by policy. Unlisted repositories do not receive a default token.

The exact policy entries are intentionally not documented here. They are service-owned authorization data and may move from checked-in code to live configuration. The durable contract is deny-by-default: unlisted principal, resource, and permission combinations do not receive tokens.

cyspbot denies forked pull request contexts, unconfigured refs, unconfigured workflow files, tag refs, unsupported event names, unsupported scopes, and non-canonical resource forms.

## GitHub App Configuration

The GitHub App registration is the upper-bound authorization control plane for repository permissions. cyspbot narrows issued tokens to one checked-in repository resource, allowed workflow context, and checked-in permission request.

Webhook delivery requires the GitHub App webhook URL to point at:

```text
https://<your-cyspbot-origin>/github/webhooks
```

## Deployment Boundary

The checked-in Wrangler configs are public-safe templates for local development, tests, and dry-runs. Production deployment is handled by a separate pipeline outside this codebase. See [docs/deployment.md](docs/deployment.md).

Do not commit the downloaded key, converted key, `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, Cloudflare tokens, or deployment overlays.

## Local Development

1. Copy `.dev.vars.example` to `.dev.vars`.
2. Fill in the GitHub App ID, webhook secret, and local PKCS#8 PEM private key.
3. Install dependencies:

   ```bash
   pnpm install
   ```

4. Run checks:

   ```bash
   pnpm run check
   ```

5. Start local dev for both Worker configs with Wrangler's multi-worker mode:

   ```bash
   pnpm run dev
   ```

6. Or start local dev for only the Worker you are changing:

   ```bash
   pnpm --filter @cyspbot/token-exchange run dev
   pnpm --filter @cyspbot/github-webhook-receiver run dev
   ```

The root Wrangler config is a test harness for Vitest bindings, not a deployable product runtime.

The public Wrangler configs declare required secret names. Secret values live in Cloudflare for production and `.dev.vars` for local development.

The token-exchange Worker uses the service-owned GitHub App from `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`.

## GitHub Actions Usage

Workflows that call cyspbot directly need permission to request a GitHub Actions OIDC token:

```yaml
permissions:
  id-token: write
```

That permission is necessary but not sufficient. cyspbot also requires the verified OIDC principal and normalized token request to match Token Policy exactly, including the configured repository, event, branch ref, `workflow_ref`, GitHub App, `resource`, and permission scope.

The reusable GitHub Action for this hosted service lives in the separate `cyspbot-app-token-action` repository.

## External References

- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [OpenID Connect Core 1.0: ID Token validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
- [GitHub Actions OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [GitHub App installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Repository Workflows

This repository has public-safe service workflows:

- `ci`: runs on pull requests and pushes to `main`; coordinates reusable jobs for formatting, linting, generated Worker bindings, type checking, Knip, tests, and Worker dry-runs.
- `run-cyspbot-deploy-update`: runs on `workflow_dispatch`, or on `workflow_run` after the `ci` workflow completes successfully on `main`; it starts the external deployment repository's update workflow.

Production deployment workflows and secrets live outside this codebase.
