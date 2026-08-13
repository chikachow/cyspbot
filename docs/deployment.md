# Deployment

This repository contains the public source, tests, and public-safe Wrangler template for the cyspbot GitHub webhook receiver. It does not contain production routes, Cloudflare resource identifiers, or secret values.

## Deployable Worker

`@cyspbot/github-webhook-receiver` deploys Worker `cyspbot-github-webhook-receiver` for `POST /github/webhooks`.

The source-owned Worker configuration defines its entrypoint, compatibility date and flags, required binding names, and local/dry-run placeholders.

## Separate deployment pipeline

[`chikachow/cyspbot-deploy`](https://github.com/chikachow/cyspbot-deploy) pins this repository as a submodule and owns the production webhook route, Cloudflare identifiers, Secrets Store binding, validation, deployment workflow, and smoke probe. A cyspbot source update must pass its own checks and a strict Wrangler dry run in that repository before deployment.

The source workflow `.github/workflows/run-cyspbot-deploy-update.yml` is responsible for dispatching the deployment repository's source-update workflow after successful `main` CI. It obtains a short-lived GitHub token through `cyspbot-app-token-action`.

## Local validation only

This repository's deployment command is a dry run:

```bash
fnm exec --using=24 corepack pnpm run deploy:dry-run
```

Do not add production credentials or routes to this repository.
