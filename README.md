# cyspbot

cyspbot serves a tiny bot page and receives signed GitHub App webhook deliveries. It validates each delivery for the configured GitHub App, classifies status commands, and queues only the jobs that require processing. It does not retain raw webhook bodies.

## Public surface

### `GET /`

The root renders a minimal HTML page identifying cyspbot as a bot. `HEAD /` returns the same status and headers without a body. Other methods at `/` return an empty `405` response with `Allow: GET, HEAD`. The root Worker returns an empty `404` response for every other path that is not carved out by a more specific Worker route.

### `POST /github/webhooks`

The webhook receiver accepts `application/json` request bodies up to `256 KiB`. A request is accepted only when it includes:

- GitHub delivery, event, and `sha256` signature headers;
- an installation target of type `integration` whose ID matches `GITHUB_APP_ID`;
- an HMAC signature that matches `GITHUB_WEBHOOK_SECRET`; and
- a syntactically valid JSON body.

Valid deliveries receive `202` after any matching status-reaction job is durably queued. Ping deliveries receive `{"accepted":true,"event":"ping"}`; other authenticated events receive `{"accepted":true}` without creating a job. A queue write failure receives `503` so GitHub can retry the delivery. See the [service contract](docs/service-contract.md) for the complete response behavior.

## Architecture

- `workers/cyspbot` owns the Hono-based root-page Worker and its public-safe Wrangler configuration.
- `workers/cyspbot-github-webhook-receiver` authenticates webhook deliveries, classifies status commands, and produces queue jobs.
- `workers/cyspbot-github-webhook-processor` consumes queue jobs, obtains a GitHub App Installation Access Token, and adds the status reaction.
- `packages/http` owns bounded request-body and JSON/problem-details response helpers.
- `packages/github` owns the shared Cloudflare secret-binding adapter used by webhook verification.
- `packages/token-exchange` owns the internal RFC 8693 client that obtains GitHub App Installation Access Tokens.
- `packages/github-webhook-jobs` owns the versioned queue-job contract shared by the receiver and processor.
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

The checks cover formatting, generated environment types, lint, type checking, unused-code detection, unit and Workerd integration tests, and Wrangler deployment dry runs for all three Workers.

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
