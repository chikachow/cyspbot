# cyspbot

cyspbot receives signed GitHub App webhook deliveries. It validates each delivery for the configured GitHub App, acknowledges valid JSON events, and does not retain raw webhook payloads or run event-specific product logic.

## Public surface

### `POST /github/webhooks`

The webhook receiver accepts `application/json` request bodies up to `256 KiB`. A request is accepted only when it includes:

- GitHub delivery, event, and `sha256` signature headers;
- an installation target of type `integration` whose ID matches `GITHUB_APP_ID`;
- an HMAC signature that matches `GITHUB_WEBHOOK_SECRET`; and
- a syntactically valid JSON body.

Valid deliveries receive `202`. Ping deliveries receive `{"accepted":true,"event":"ping"}`; other events receive `{"accepted":true}`. See the [service contract](docs/service-contract.md) for the complete response behavior.

## Architecture

- `workers/cyspbot-github-webhook-receiver` owns the deployable Worker, its route, runtime composition, and public-safe Wrangler configuration.
- `packages/http` owns bounded request-body and JSON/problem-details response helpers.
- `packages/github` owns the shared Cloudflare secret-binding adapter used by webhook verification.
- The root Wrangler configuration is a test harness, not a deployable product Worker.

The source repository intentionally contains no Cloudflare account IDs, production routes, or secret values. Production ownership and service boundaries are documented in [deployment](docs/deployment.md).

## Local development

Use Node 24 and the pinned pnpm version:

```bash
fnm exec --using=24 corepack pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
fnm exec --using=24 corepack pnpm run dev
```

Fill in the GitHub App ID and webhook secret in `.dev.vars`. Do not commit that file.

Run the complete validation suite with:

```bash
fnm exec --using=24 corepack pnpm run check
fnm exec --using=24 corepack pnpm run test:coverage
```

The checks cover formatting, generated environment types, lint, type checking, unused-code detection, unit and Workerd integration tests, and a Wrangler deployment dry run for the webhook Worker.

## Deployment trigger

After successful CI on `main`, `.github/workflows/run-cyspbot-deploy-update.yml` requests a short-lived token through `cyspbot-app-token-action` and dispatches the `cyspbot-deploy` source-update workflow.

## Repository workflows

- `ci`: coordinates formatting, lint, generated environment types, type checking, Knip, tests, coverage reporting, and Wrangler dry runs.
- `pnpm-up`: proposes pinned dependency updates.
- `run-cyspbot-deploy-update`: requests the deployment repository to update its pinned cyspbot source revision after successful `main` CI.

## Documentation

- [Service contract](docs/service-contract.md)
- [Implementation](docs/implementation.md)
- [Deployment and service boundaries](docs/deployment.md)
- [Release checklist](docs/release.md)
