# cyspbot

cyspbot is a hosted Security Token Service for GitHub Actions workflows. It verifies trusted GitHub Actions OIDC tokens and exchanges allowed workflow contexts for short-lived, repository-scoped GitHub App installation access tokens without exposing the GitHub App private key outside Cloudflare.

The current product is intentionally narrow:

- `POST /token` is the primary token exchange endpoint.
- `POST /github/claims` verifies caller identity and GitHub App installation presence without issuing an Installation Token.
- `POST /github/webhooks` accepts signed GitHub App webhooks, records metadata, and signals installation reconciliation.
- `GET /dashboard` is a read-only operational dashboard for repository visibility and recent Installation Token Issuance audit history.

The primary service contract is [docs/service-contract.md](/Users/STalbot@Scentregroup.com/src/cysp/cyspbot/docs/service-contract.md). The documentation map is [docs/README.md](/Users/STalbot@Scentregroup.com/src/cysp/cyspbot/docs/README.md).

## Implemented Architecture

- Cloudflare Worker routing for token exchange, claims, webhook, dashboard, login, and setup routes.
- One `OidcIssuerVerifierObject` Durable Object per trusted OIDC issuer for JWKS coordination, bounded stale serving, and refresh backoff.
- One `GitHubInstallationObject` Durable Object per GitHub App Installation for reconciliation signal coalescing only.
- D1-backed Dashboard Sessions, Audit Log, issued-token facts, Webhook Delivery Log metadata, and reconciliation state.
- GitHub App private key in Cloudflare Secrets Store for production; local PKCS#8 PEM fallback for development and tests.
- Checked-in Token Policy code that allows Installation Token Issuance only for default-branch `schedule` and `workflow_dispatch` contexts.

## Current Public Surface

### `POST /token`

Primary endpoint for Installation Token Issuance. It accepts `application/x-www-form-urlencoded` OAuth token exchange input:

```http
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<github-actions-oidc-token>
subject_token_type=urn:ietf:params:oauth:token-type:id_token
```

`subject_token_type` may also be `urn:ietf:params:oauth:token-type:jwt`. `requested_token_type` is optional and may be either `urn:chikachow:github-app-installation-access-token` or `urn:ietf:params:oauth:token-type:access_token`.

Successful responses use OAuth token response shape and `Cache-Control: no-store`:

```json
{
  "access_token": "ghs_...",
  "issued_token_type": "urn:chikachow:github-app-installation-access-token",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

### `POST /github/claims`

Verifies a GitHub Actions OIDC bearer token and confirms the configured GitHub App is installed on the calling repository. It does not evaluate the full Token Policy and does not issue a token.

```json
{
  "repository_id": "123456789",
  "repository": "owner/example",
  "event_name": "workflow_dispatch",
  "ref": "refs/heads/main"
}
```

### `POST /github/webhooks`

Accepts signed JSON GitHub App webhook deliveries up to `256 KiB`. Non-`ping` events require a positive integer `installation.id`. Accepted non-`ping` deliveries signal the per-installation coordinator and write metadata to D1. Raw webhook bodies are not retained.

## Dashboard

The dashboard uses GitHub App user authorization, not GitHub Actions OIDC. A Dashboard User can see only repositories GitHub returns for that user through the GitHub App user-to-server installation repository APIs.

Implemented dashboard routes:

- `GET /` redirects to `/dashboard`
- `GET /github/setup`
- `GET /login/github`
- `GET /auth/github/callback`
- `GET /logout`
- `GET /dashboard`
- `GET /dashboard/repositories/:owner/:name`

Repository detail URLs use current `owner/name` as a locator. The service resolves that to immutable GitHub repository ID internally after confirming the signed-in user can see the repository through GitHub's user-to-server APIs.

## Current Token Policy

Installation Token Issuance is allowed only when all implemented checks pass:

- the caller is a verified GitHub Actions principal from the configured issuer
- `event_name` is `schedule` or `workflow_dispatch`
- the OIDC subject context is `ref`
- the OIDC subject repository matches the resolved repository
- `sub` and `ref` both identify the repository's current default branch ref
- `ref_type` is `branch`
- `repository`, `repository_id`, `repository_owner_id`, and `repository_visibility` match live GitHub repository metadata

The caller cannot choose a repository or permission profile. The issued token is scoped to the Calling Repository, and cyspbot requests checked-in permissions sufficient to commit changes and raise pull requests: `contents: write` and `pull_requests: write`. The current GitHub App installation permissions remain the upper bound.

cyspbot denies `push`, `pull_request`, `pull_request_target`, forked pull request contexts, non-default-branch refs, tag refs, and unsupported event names.

## Future Implementation Plan

Planned future work is additive and must preserve the current trust boundary:

- full Installation Reconciliation execution with installation-slice replacement in D1
- scheduled retry dispatch for pending or failed reconciliation work
- cleanup jobs for expired Dashboard Sessions, Audit Log retention, reconciliation history, and Webhook Delivery Log metadata
- optional dashboard diagnostics for reconciliation failures
- optional dashboard filtering or sorting over already-authorized rendered data

Excluded from the current product surface:

- caller-selected repositories
- caller-selected permission profiles
- dynamic OIDC issuer discovery
- webhook replay from cyspbot-retained raw payloads
- rearchitecting the security boundary for modernization alone

## GitHub App Configuration

The GitHub App registration is the upper-bound authorization control plane for repository permissions. cyspbot narrows issued tokens to the calling repository, allowed workflow contexts, and the checked-in permission request used for token issuance.

Dashboard setup uses separate GitHub App URLs:

- Setup URL: `https://cyspbot.chikachow.org/github/setup`
- OAuth callback URL: `https://cyspbot.chikachow.org/auth/github/callback`

`Request user authorization (OAuth) during installation` is disabled so GitHub can use the distinct Setup URL. Setup callbacks are treated as untrusted onboarding entrypoints and redirect into the normal stateful dashboard login flow.

## Cloudflare Setup

Production is configured for the custom domain `cyspbot.chikachow.org`. The production Worker also enables its `workers.dev` route for operational smoke tests when the custom domain is blocked by local network policy. The custom domain remains the canonical GitHub App setup, OAuth callback, and webhook URL.

1. Convert the downloaded GitHub App key to PKCS#8:

   ```bash
   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in cyspbot.private-key.pem -out cyspbot.private-key.pkcs8.pem
   ```

2. Add the PKCS#8 private key to Cloudflare Secrets Store:

   ```bash
   pnpm exec wrangler secrets-store secret create <STORE_ID> --name CYSPBOT_GITHUB_APP_PRIVATE_KEY --scopes workers --remote < cyspbot.private-key.pkcs8.pem
   ```

3. Configure the required production bindings and secrets:
   - `GITHUB_APP_ID`
   - `GITHUB_APP_CLIENT_ID`
   - `GITHUB_APP_CLIENT_SECRET`
   - `GITHUB_APP_PRIVATE_KEY`
   - `GITHUB_WEBHOOK_SECRET`
   - `DASHBOARD_SESSION_LOOKUP_SECRET`
   - `DASHBOARD_TOKEN_ENCRYPTION_SECRET`
   - D1 binding `DB`
   - Durable Object bindings `GITHUB_INSTALLATION` and `OIDC_ISSUER_VERIFIER`

4. Apply D1 migrations from [migrations](/Users/STalbot@Scentregroup.com/src/cysp/cyspbot/migrations).

5. Deploy:

   ```bash
   pnpm run deploy:production
   ```

## Local Development

1. Copy `.dev.vars.example` to `.dev.vars`.
2. Fill in the GitHub App ID, GitHub App client credentials, Dashboard Session secrets, webhook secret, and local PKCS#8 PEM private key.
3. Install dependencies:

   ```bash
   pnpm install
   ```

4. Run checks:

   ```bash
   pnpm run check
   ```

5. Start local dev:

   ```bash
   pnpm run dev
   ```

Production uses Secrets Store. Local development and tests may use `GITHUB_APP_PRIVATE_KEY_PEM`.

## GitHub Actions Usage

Workflows that call cyspbot directly need:

```yaml
permissions:
  id-token: write
```

The reusable GitHub Action for this hosted service lives in the separate `cyspbot-app-token-action` repository.

## Repository Workflows

This repository has two workflows:

- `ci`: runs on pull requests and pushes to `main`; executes `node --run check`
- `deploy`: runs after successful `ci` on a `main` push; deploys to production

Deployment expects these GitHub secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
