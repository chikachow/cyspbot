# cyspbot

cyspbot is a hosted Security Token Service for GitHub Actions workflows. It verifies trusted GitHub Actions OIDC tokens and exchanges allowed workflow contexts for short-lived, repository-scoped GitHub App installation access tokens without exposing the GitHub App private key outside Cloudflare.

The current product is intentionally narrow:

- `POST /token` is the primary token exchange endpoint.
- `POST /github/claims` verifies caller identity and GitHub App installation presence without issuing an Installation Token.
- `POST /github/webhooks` accepts signed GitHub App webhooks and signals installation reconciliation.
- Signed `pull_request` webhooks enqueue a pull request haiku comment refresh when the Flagship feature flag is enabled and the repository is opted in.
- `GET /dashboard` is an operational dashboard for repository visibility, recent Installation Token Issuance audit history, and admin pull request haiku opt-ins.

The primary service contract is [docs/service-contract.md](docs/service-contract.md). The documentation map is [docs/README.md](docs/README.md).

## Implemented Architecture

- Cloudflare Worker routing for token exchange, claims, webhook, dashboard, login, and setup routes.
- One `OidcIssuerVerifierObject` Durable Object per trusted OIDC issuer for JWKS coordination, bounded stale serving, and refresh backoff.
- One `GitHubInstallationObject` Durable Object per GitHub App Installation for reconciliation signal coalescing only.
- D1-backed Dashboard Sessions, Audit Log, issued-token facts, reconciliation state, and pull request haiku state.
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

`subject_token_type` may also be `urn:ietf:params:oauth:token-type:jwt`. `requested_token_type` is optional and may be either the cyspbot GitHub App installation token URN or `urn:ietf:params:oauth:token-type:access_token`.

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

Accepts signed JSON GitHub App webhook deliveries up to `256 KiB`. Webhook target headers must identify the configured GitHub App. Non-`ping` events require a positive integer `installation.id`. Accepted non-`ping` deliveries signal the per-installation coordinator. Raw webhook bodies are not retained.

When the `pull-request-haiku` Flagship feature flag is enabled, repositories listed in `pull_request_haiku_repository_opt_ins` have accepted `pull_request` deliveries for `opened`, `reopened`, `synchronize`, `edited`, and `ready_for_review` enqueue asynchronous haiku comment work. The worker reads mechanical change facts from the pull request and changed file list, excluding human-authored pull request text such as title and body, then creates or updates one marker-owned pull request comment containing:

- a generated haiku representing the pull request change

The model input includes filenames and aggregate change counts. Filenames can still reveal sensitive project structure in private repositories, so repositories must be explicitly opted in.

## Dashboard

The dashboard uses GitHub App user authorization, not GitHub Actions OIDC. A Dashboard User can see only repositories GitHub returns for that user through the GitHub App user-to-server installation repository APIs.

Implemented dashboard routes:

- `GET /` redirects to `/dashboard`
- `GET /github/setup`
- `GET /login/github`
- `GET /auth/github/callback`
- `GET /logout`
- `GET /dashboard`
- `GET`, `POST /dashboard/pull-request-haikus`
- `GET /dashboard/repositories/:owner/:name`

Repository detail URLs use current `owner/name` as a locator. The service resolves that to immutable GitHub repository ID internally after confirming the signed-in user can see the repository through GitHub's user-to-server APIs.

Pull request haiku administration follows GitHub repository permissions. A Dashboard User can view and change haiku opt-in state only for repositories where GitHub reports that user has repository `admin` permission through the GitHub App user-to-server installation repository APIs.

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
- cleanup jobs for expired Dashboard Sessions, Audit Log retention, reconciliation history, and pull request haiku run history
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

Pull request haiku comments require the installed GitHub App to grant `Pull requests: write` and `Issues: write`. cyspbot requests those permissions only for the opted-in pull request comment worker.

Dashboard setup uses separate GitHub App URLs:

- Setup URL: `https://<your-cyspbot-origin>/github/setup`
- OAuth callback URL: `https://<your-cyspbot-origin>/auth/github/callback`

`Request user authorization (OAuth) during installation` is disabled so GitHub can use the distinct Setup URL. Setup callbacks are treated as untrusted onboarding entrypoints and redirect into the normal stateful dashboard login flow.

## Cloudflare Setup

The checked-in `wrangler.jsonc` contains the current production Worker bindings and can deploy cyspbot directly. See [docs/deployment.md](docs/deployment.md).

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
   - Flagship binding `FLAGS` for the `pull-request-haiku` feature flag

4. Apply D1 migrations from [migrations](migrations).

5. Deploy:

   ```bash
   pnpm run deploy
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

The pull request haiku worker also expects the configured queue to exist before deployment:

```bash
pnpm exec wrangler queues create cyspbot-pr-haiku
pnpm exec wrangler queues create cyspbot-pr-haiku-test
```

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
