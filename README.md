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
- Checked-in Token Policy code that allows Installation Token Issuance only for default-branch `schedule` and `workflow_dispatch` contexts after live repository metadata verification.

## Current Public Surface

### `POST /token`

Primary endpoint for Installation Token Issuance. It accepts `application/x-www-form-urlencoded` OAuth token exchange input:

```http
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<github-actions-oidc-token>
subject_token_type=urn:ietf:params:oauth:token-type:id_token
```

`subject_token_type` may also be `urn:ietf:params:oauth:token-type:jwt`. `requested_token_type` is optional and may be either the cyspbot GitHub App installation token URN or `urn:ietf:params:oauth:token-type:access_token`.

Successful responses use OAuth token response shape with `Cache-Control: no-store` and `Pragma: no-cache`:

```json
{
  "access_token": "ghs_...",
  "issued_token_type": "urn:chikachow:github-app-installation-access-token",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

### `POST /github/webhooks`

Accepts signed JSON GitHub App webhook deliveries up to `256 KiB`. Webhook target headers must identify the configured GitHub App. Raw webhook bodies are not retained.

Signed `ping` deliveries return `202 {"accepted":true,"event":"ping"}`. Any other valid signed JSON event returns `202 {"accepted":true}` with no event-specific parsing or downstream work.

## Current Token Policy

Installation Token Issuance is allowed only when all implemented checks pass:

- the caller is a verified GitHub Actions principal from the configured issuer
- the OIDC token audience is `cyspbot`, and any `azp` claim also identifies `cyspbot`
- `event_name` is `schedule` or `workflow_dispatch`
- the OIDC subject context is `ref`
- `sub` and `ref` both identify the repository's current default branch ref
- `ref_type` is `branch`
- `repository`, `repository_id`, `repository_owner_id`, and `repository_visibility` match live GitHub repository metadata

The caller cannot choose a repository or permission profile. The issued token is scoped to the Calling Repository, and cyspbot requests checked-in permissions sufficient to commit changes and raise pull requests: `contents: write` and `pull_requests: write`. The current GitHub App installation permissions remain the upper bound.

cyspbot denies `push`, `pull_request`, `pull_request_target`, forked pull request contexts, non-default-branch refs, tag refs, and unsupported event names.

## GitHub App Configuration

The GitHub App registration is the upper-bound authorization control plane for repository permissions. cyspbot narrows issued tokens to the calling repository, allowed workflow contexts, and the checked-in permission request used for token issuance.

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

## GitHub Actions Usage

Workflows that call cyspbot directly need:

```yaml
permissions:
  id-token: write
```

The reusable GitHub Action for this hosted service lives in the separate `cyspbot-app-token-action` repository.

## External References

- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [GitHub Actions OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [GitHub App installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Repository Workflows

This repository has one public-safe umbrella workflow:

- `ci`: runs on pull requests and pushes to `main`; coordinates reusable jobs for formatting, linting, generated Worker bindings, type checking, Knip, tests, and Worker dry-runs.

Production deployment workflows and secrets live outside this codebase.
