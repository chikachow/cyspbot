# Deployment

This repository contains the cyspbot Worker implementation, tests, public documentation, and public-safe Wrangler template configuration for local development, tests, and dry-runs.

Production deployment is handled by a separate pipeline outside this codebase.

## Deployable Worker Packages

The implementation is split into two deployable workspace packages:

- `@cyspbot/token-exchange` deploys Worker `cyspbot-token-exchange`: `/token`, OpenID Connect ID Token verification, token policy, GitHub App installation token issuance
- `@cyspbot/github-webhook-receiver` deploys Worker `cyspbot-github-webhook-receiver`: `/github/webhooks`, signature validation, target app validation, JSON validation, and acknowledgement

This source repository owns:

- public-safe deployable package templates under `workers/*`
- package-owned Worker adapters, routes, dependency defaults, and Wrangler configs
- shared package modules under `packages/*` for HTTP helpers, GitHub clients, OpenID Connect ID Token verification, and provider-specific issuer-adapter handling
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

## Fly.io Issuer Trust Configuration

`FLY_OIDC_ORG_SLUGS` is non-secret but security-sensitive trust configuration owned by the production deployment pipeline. Set it to a comma-delimited list of reviewed Fly Organization Slugs to configure organization-specific Trusted OIDC Issuers. An empty value configures no Fly Trusted OIDC Issuer, which is the intentional default in the public-safe Wrangler template. A missing binding is logged and treated as no Fly trust without disabling other configured OIDC providers.

Each accepted entry configures one independent Trusted OIDC Issuer with an Issuer Identifier of the form `https://oidc.fly.io/{org-slug}`. Empty and duplicate entries are ignored. An entry with unsupported Fly issuer-path syntax is logged without its value and skipped without affecting other configured Fly issuers. Syntax acceptance does not establish that the organization exists.

Changing this binding changes which Fly issuers cyspbot trusts for authentication and requires security review. Configuring a Trusted OIDC Issuer does not create an authorization grant; Token Policy separately controls Installation Token Issuance.

## Token Exchange Protocol Rollouts

Changes that alter `/token` request shape must be deployed before repository workflows are updated to depend on the new shape. Keep the deploy-trigger workflow on an action version and inputs that the currently live Worker already authorizes, deploy the new Worker, then update the workflow to the new action/input shape in a follow-up change.

This ordering prevents self-deployment deadlocks: a policy or workflow identity in source code is not usable until the Worker containing that policy has been deployed.

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
