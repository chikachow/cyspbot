# Deployment

This repository contains the cyspbot Worker implementation, tests, migrations, public documentation, and current production deployment configuration.

The checked-in `wrangler.jsonc` can deploy cyspbot directly. A private deployment repository remains a later publishing option, but it is not the current implementation.

## Direct Deployment

This repository owns:

- `wrangler.jsonc` with the production Worker name, routes, D1 database ID, Durable Object migrations, queues, Secrets Store ID, Flagship app ID, and non-secret GitHub App identifiers
- GitHub Actions deployment workflow
- Cloudflare binding declarations
- D1 migrations

Deployment expects GitHub environment secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Local deployment uses:

```bash
pnpm run deploy
```

## Private Deployment Repository

A future private deployment repository could own:

- `wrangler.jsonc` with the production Worker name, routes, D1 database IDs, Durable Object migrations, queues, Secrets Store IDs, Flagship app IDs, and non-secret GitHub App identifiers
- GitHub Actions deployment workflows
- Cloudflare account and API token secrets
- runbooks for creating Cloudflare resources and rotating GitHub App keys
- environment-specific smoke tests

The private repository can consume this source repository by one of these patterns:

1. Git submodule or subtree at `vendor/cyspbot`.
2. Git checkout of this repository at a pinned commit during CI.
3. Package artifact once this repository publishes one.

For this future split, a pinned checkout is the simplest boundary: the private deployment workflow checks out this repository at a reviewed commit, overlays or supplies its private `wrangler.jsonc`, runs `pnpm install --frozen-lockfile`, runs `node --run check`, applies D1 migrations, and runs `wrangler deploy`.

## Publishing Boundary

Before publishing this repository publicly, either move deployment configuration out or intentionally accept that these deployment identifiers are public:

- Cloudflare account IDs or API tokens
- D1 database IDs
- Secrets Store IDs
- Flagship app IDs
- GitHub App client IDs, app IDs, private keys, client secrets, or webhook secrets
- dashboard session lookup or token-encryption secrets
- local `.dev.vars`
- generated `.wrangler` state

Never commit private keys, client secrets, webhook secrets, dashboard session secrets, local `.dev.vars`, generated `.wrangler` state, Cloudflare account IDs, or API tokens.

## Dashboard Administration

Dashboard haiku administration follows GitHub repository permissions. The dashboard uses GitHub's user-to-server installation repository response as the authorization source and grants haiku opt-in administration only for repositories where GitHub reports repository `admin` permission for the signed-in user.

Do not infer dashboard administration merely from the fact that the user can see a repository through the app installation. Visibility is not administration. If GitHub omits the repository `admin` permission bit, cyspbot treats that repository as not administered by the dashboard user.
