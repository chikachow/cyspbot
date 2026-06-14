# Deployment

This repository contains the cyspbot Worker implementation, tests, public documentation, and public-safe Wrangler template configuration for local development, tests, and dry-runs.

Production deployment is handled by a separate pipeline outside this codebase.

## Deployable Worker Packages

The implementation is split into two deployable workspace packages:

- `@cyspbot/token-exchange` deploys Worker `cyspbot-token-exchange`: `/token`, OIDC verification, token policy, GitHub App installation token issuance
- `@cyspbot/github-webhook-receiver` deploys Worker `cyspbot-github-webhook-receiver`: `/github/webhooks`, signature validation, target app validation, JSON validation, and acknowledgement

This source repository owns:

- public-safe deployable package templates under `workers/*`
- package-owned Worker adapters, routes, dependency defaults, and Wrangler configs
- shared package modules under `packages/*` for HTTP helpers, GitHub clients, generic OIDC verification, and GitHub Actions OIDC claim interpretation
- Cloudflare binding declarations required by the source
- tests and dry-run checks for the two Worker packages

The checked-in Worker configs are local-development and dry-run templates only.

## Separate Deployment Pipeline

The separate deployment pipeline should:

1. Check out this source repository at a reviewed commit.
2. Install dependencies.
3. Run `node --run check`.
4. Deploy Worker packages: token exchange and webhook receiver.
5. Smoke-test `/token` and `/github/webhooks` on the production origin.

Local `pnpm run dev` uses Wrangler's multi-worker mode for separated Worker configs. Wrangler exposes only the first config locally and runs the rest as auxiliary Workers, so local dev does not replace same-origin route proof in the deployment environment. Local dev uses repository-local `.wrangler` state for Wrangler logs and the dev registry.

## Public Source Boundary

Do not commit:

- Cloudflare account IDs or API tokens
- GitHub App IDs, private keys, or webhook secrets
- local `.dev.vars`
- local `.env`
- generated `.wrangler` state
- private deployment overlays or workflow secrets

Public-safe template configs may include placeholder IDs, local-only values, and required binding names.

Build release artifacts from tracked source files, not from the working directory. This matters because local development intentionally creates ignored files such as `.dev.vars`, `.wrangler/`, `.local-secrets/`, dependency directories, and local GitHub App key files.

## External References

- [Cloudflare Workers Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
