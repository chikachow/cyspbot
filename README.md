# cyspbot

Cyspbot is the hosted automation application for cysp. Its current capability is issuing short-lived GitHub installation tokens to approved GitHub Actions workflows without exposing the GitHub App private key outside Cloudflare.

## Hosted contract

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
  - Authenticates the caller with a GitHub Actions OIDC token.
  - Allows only `schedule`, `workflow_dispatch`, and `push` on the repository's current default branch.
  - Mints a fresh installation token with fixed permissions:
    - `contents: write`
    - `pull_requests: write`
  - Returns:
    ```json
    {
      "token": "ghs_...",
      "expires_at": "2026-05-19T12:34:56Z"
    }
    ```

Both endpoints expect:

```http
Authorization: Bearer <github-actions-oidc-token>
```

Errors use minimal `application/problem+json` responses.

## Architecture

- Cloudflare Worker for OIDC verification, routing, and GitHub API calls.
- One Durable Object per GitHub App installation.
- Durable Object stores a bounded audit log of token requests only:
  - retain entries for up to 180 days
  - retain at most 5000 entries per installation
- Cloudflare Secrets Store holds the GitHub App private key.
- GitHub App installation is repository authorization.

## GitHub App requirements

The existing GitHub App registration should be configured so installation tokens can do the one known job:

- Repository permissions:
  - `Contents: Read and write`
  - `Pull requests: Read and write`

Cyspbot itself narrows each minted token to the calling repository and the fixed permission set above.

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
6. Verify Wrangler auth:
   ```bash
   pnpm run wrangler:whoami
   ```
7. Deploy:
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
2. Fill in the GitHub App ID and a local PKCS#8 PEM private key.
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

## GitHub Actions usage

Workflows that call Cyspbot directly need `id-token: write`.

The reusable GitHub Action client for Cyspbot lives in the separate `cyspbot-action` repository. This repository documents and deploys the hosted Cyspbot service.

Cyspbot will deny `pull_request`, `pull_request_target`, and non-default-branch `push` events.
