# Deployment

This repository contains the public source, tests, and public-safe Wrangler templates for the cyspbot root page and GitHub webhook receiver. It does not contain production domains, routes, Cloudflare resource identifiers, or secret values.

## Deployable Workers

`@cyspbot/cyspbot` deploys Worker `cyspbot` as the fallback origin. Its Hono application serves the root bot page for `GET` and standard bodyless `HEAD` requests, rejects other root methods with an empty `405`, and returns empty `404` responses for other paths.

`@cyspbot/github-webhook-receiver` deploys Worker `cyspbot-github-webhook-receiver` for `POST /github/webhooks`.

The source-owned Worker configurations define their entrypoints, compatibility dates and flags, required binding names, and local/dry-run placeholders.

## Separate deployment pipeline

[`chikachow/cyspbot-deploy`](https://github.com/chikachow/cyspbot-deploy) pins this repository as a submodule and owns the production Custom Domain, webhook route, Cloudflare identifiers, Secrets Store binding, validation, deployment workflow, and smoke probes. The specific webhook route executes before the Custom Domain origin Worker. A cyspbot source update must pass its own checks and strict Wrangler dry runs in that repository before deployment.

The source workflow `.github/workflows/run-cyspbot-deploy-update.yml` is responsible for dispatching the deployment repository's source-update workflow after successful `main` CI. It obtains a short-lived GitHub token through `cyspbot-app-token-action`.

## Local validation only

This repository's deployment command is a dry run:

```bash
fnm exec --using=24 corepack pnpm run deploy:dry-run
```

Do not add production credentials, domains, or routes to this repository.
