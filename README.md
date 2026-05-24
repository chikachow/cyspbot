# cyspbot

Cyspbot is the hosted automation application for cysp. It exchanges trusted GitHub Actions OIDC tokens for short-lived GitHub App installation access tokens without exposing the GitHub App private key outside Cloudflare.

The dashboard, Audit Log, Repository Visibility Cache, and session state are D1-backed. The detailed persistence design is [docs/dashboard-d1-recut.md](/Users/STalbot@Scentregroup.com/src/cysp/cyspbot/docs/dashboard-d1-recut.md).

## Hosted contract

- `POST /token`
  - Primary endpoint for token exchange.
  - Implements an RFC 8693 OAuth 2.0 Token Exchange-style contract on the OAuth token endpoint shape from RFC 6749.
  - Accepts `application/x-www-form-urlencoded` with:
    - `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
    - `subject_token=<github-actions-oidc-token>`
    - `subject_token_type=urn:ietf:params:oauth:token-type:id_token`
    - optional `requested_token_type`, supporting:
      - `urn:chikachow:github-app-installation-access-token`
      - `urn:ietf:params:oauth:token-type:access_token`
  - Evaluates GitHub OIDC trust claims with a small checked-in policy function in plain code.
  - The current default policy:
    - allows only `schedule`, `workflow_dispatch`, and `push`
    - requires the OIDC `sub` and `ref` context to target the repository's current default branch
    - denies `pull_request` and `pull_request_target`
  - Issues a fresh GitHub App installation access token:
    - scoped to the calling repository only
    - with whatever repository permissions the GitHub App currently has for that repository
  - Returns:
    ```json
    {
      "access_token": "ghs_...",
      "issued_token_type": "urn:chikachow:github-app-installation-access-token",
      "token_type": "Bearer",
      "expires_in": 3600
    }
    ```
  - When issuing the upstream GitHub App installation access token, Cyspbot currently opts in to GitHub's temporary stateless token override with `X-GitHub-Stateless-S2S-Token: enabled`.
- `POST /github/claims`
  - Authenticates the caller with a GitHub Actions OIDC token.
  - Confirms the configured GitHub App is installed on the calling repository.
  - Returns:
    ```json
    {
      "repository_id": "123456789",
      "repository": "cysp/terraform-provider-contentful",
      "event_name": "workflow_dispatch",
      "ref": "refs/heads/main"
    }
    ```
- `POST /github/installations/token`
  - Legacy compatibility endpoint.
  - Authenticates the caller with a GitHub Actions OIDC token.
  - Applies the same OIDC trust policy as `POST /token`.
  - Issues a fresh GitHub App installation access token:
    - scoped to the calling repository only
    - with whatever repository permissions the GitHub App currently has for that repository
  - Returns:
    ```json
    {
      "token": "ghs_...",
      "expires_at": "2026-05-19T12:34:56Z"
    }
    ```

## Dashboard surface

The dashboard uses GitHub App user authorization and D1-backed sessions:

- `GET /login/github`
- `GET /auth/github/callback`
- `GET /logout`
- `GET /dashboard`
- `GET /dashboard/repositories/:owner/:name`

Repository detail URLs use the current `owner/name` display path. The route resolves that locator to the immutable GitHub repository id internally and authorizes every detail page from fresh Repository Visibility Cache rows.

GitHub App installation setup callbacks may also arrive at `GET /auth/github/callback` with `installation_id` and `setup_action` but without Cyspbot's OAuth `state` cookie. Cyspbot does not exchange those unstateful codes; it clears any stale state cookie and redirects to `/login/github?return_to=/dashboard` to start the normal stateful dashboard login.

`POST /token` expects:

```http
Content-Type: application/x-www-form-urlencoded
```

The legacy GitHub-specific endpoints expect:

```http
Authorization: Bearer <github-actions-oidc-token>
```

`POST /token` returns OAuth-style JSON token or error responses with `Cache-Control: no-store`.

The GitHub-specific endpoints use minimal `application/problem+json` responses.

## Architecture

- Cloudflare Worker for OIDC verification, routing, and GitHub API calls.
- A checked-in Token Policy function with explicit claim comparisons and allow/deny rules.
- The current policy evaluates immutable GitHub OIDC identity claims and workflow context claims, including:
  - `sub`
  - `repository_id`
  - `repository_owner_id`
  - `repository_visibility`
  - `ref`
  - `ref_type`
  - `workflow_ref`
  - `job_workflow_ref`
  - `environment`
- One Durable Object per trusted OIDC issuer for verifier/JWKS coordination.
- One Durable Object per GitHub App Installation is retained only for Installation Reconciliation signal coalescing and serialized execution.
- D1 is the durable system of record for the Audit Log, Dashboard Sessions, installation/repository projection, Repository Visibility Cache, Webhook Delivery Log metadata, and Installation Reconciliation state and run history.
- Cloudflare Secrets Store holds the GitHub App private key.
- GitHub App installation is repository authorization.

## GitHub App requirements

The existing GitHub App registration is the primary authorization control plane for what repository actions Cyspbot-issued tokens can perform:

- Repository permissions:
  - Any permissions granted here can flow through to repository-scoped tokens issued by Cyspbot.
  - Cyspbot still narrows tokens to the calling repository and allowed workflow contexts, but it does not down-scope the app's repository permissions further at issuance time.

Cyspbot records each authenticated issuance attempt in a central D1 audit row before live GitHub lookup. A successful token response requires the terminal audit row and issued-token child rows to persist.

For the dashboard, GitHub App user authorization is the visibility control plane:

- A signed-in Dashboard User may only see repositories returned by GitHub for that user through:
  - `GET /user/installations`
  - `GET /user/installations/{installation_id}/repositories`
- Installation Tokens still represent what the app can do, not what a human Dashboard User may see.
- The Repository Visibility Cache is a short-lived D1-backed cache keyed by Dashboard User and GitHub App Installation.

## Cloudflare setup

1. Create or choose a Secrets Store.
2. Convert the downloaded GitHub App key from PKCS#1 to PKCS#8:
   ```bash
   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in cyspbot.private-key.pem -out cyspbot.private-key.pkcs8.pem
   ```
3. Add the PKCS#8 private key to Secrets Store:
   ```bash
   pnpm exec wrangler secrets-store secret create <STORE_ID> --name CYSPBOT_GITHUB_APP_PRIVATE_KEY --scopes workers --remote < cyspbot.private-key.pkcs8.pem
   ```
4. Replace `REPLACE_WITH_SECRETS_STORE_ID` in [wrangler.jsonc](/Users/STalbot@Scentregroup.com/src/cysp/cyspbot/wrangler.jsonc).
5. Replace `REPLACE_WITH_GITHUB_APP_ID` in [wrangler.jsonc](/Users/STalbot@Scentregroup.com/src/cysp/cyspbot/wrangler.jsonc).
6. Configure Dashboard authentication and Dashboard Session secrets:
   - `GITHUB_APP_CLIENT_ID`
   - `GITHUB_APP_CLIENT_SECRET`
   - `DASHBOARD_SESSION_LOOKUP_SECRET`
   - `DASHBOARD_TOKEN_ENCRYPTION_SECRET`
7. Create or bind the D1 database named `cyspbot`, then apply migrations from [migrations](/Users/STalbot@Scentregroup.com/src/cysp/cyspbot/migrations).
8. Verify Wrangler auth:
   ```bash
   pnpm run wrangler:whoami
   ```
9. Deploy:
   ```bash
   pnpm run deploy:production
   ```

Production is configured to attach the Worker to the custom domain `cyspbot.chikachow.org`.

## GitHub Actions for this repo

This repository now has two workflows:

- `ci`: runs on pull requests and pushes to `main`, and executes the canonical `node --run check` script.
- `deploy`: runs automatically after a successful `ci` workflow on a `main` push and deploys directly to production.

Deployment expects these GitHub secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

The Cloudflare API token should be scoped narrowly to the account and Worker deployment access needed for this project. Cloudflare's Workers GitHub Actions docs call out those two secrets as the required non-interactive authentication inputs for Wrangler: [GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

## Local development

1. Copy `.dev.vars.example` to `.dev.vars`.
2. Fill in the GitHub App ID, GitHub App client credentials, Dashboard Session secrets, and a local PKCS#8 PEM private key.
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

Local development falls back to `GITHUB_APP_PRIVATE_KEY_PEM` from `.dev.vars`; production should use Secrets Store. Cyspbot expects PKCS#8 PEM for both paths.

Worker tests inject auth and GitHub API test doubles at the app boundary. Production code does not branch on test-only environment variables.

## GitHub Actions usage

Workflows that call Cyspbot directly need `id-token: write`.
Under the current Token Policy, Installation Token Issuance is limited to default-branch `ref` contexts for `schedule`, `workflow_dispatch`, and `push`.
The current checked-in policy is intentionally narrow, but the claim mapping keeps `workflow_ref`, `job_workflow_ref`, and `environment` available for stricter future checks without changing the endpoint contract.

The reusable GitHub Action client for Cyspbot lives in the separate `cyspbot-action` repository. This repository documents and deploys the hosted Cyspbot service.

Cyspbot will deny `pull_request`, `pull_request_target`, and any non-default-branch `ref` context under the default policy.

## GitHub Webhooks

`POST /github/webhooks` accepts signed GitHub App webhook deliveries for installation-scoped events and also accepts the initial signed `ping` delivery used when GitHub validates a webhook configuration. Webhook deliveries signal Installation Reconciliation through `GitHubInstallationObject`; Webhook Delivery Log metadata and Installation Reconciliation state live in D1. Raw webhook bodies are not retained.
