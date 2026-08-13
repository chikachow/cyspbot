# Implementation

## Workspace layout

cyspbot is a pnpm workspace with two deployable Cloudflare Workers:

- `workers/cyspbot` publishes `@cyspbot/cyspbot` and Worker `cyspbot`.
- `workers/cyspbot-github-webhook-receiver` publishes `@cyspbot/github-webhook-receiver` and Worker `cyspbot-github-webhook-receiver`.

Shared packages:

- `packages/http` provides bounded body reading, request-body handling, JSON responses, and problem-details responses.
- `packages/github` provides the string-or-Secrets-Store secret-binding adapter used by webhook verification.

The root `wrangler.jsonc` points at `test/support/root-test-harness.ts`. It supplies common bindings to unit tests and is not a deployable product Worker.

## Root Worker flow

`workers/cyspbot/src/worker.ts` uses Hono's tiny preset. Its `GET /` route returns the minimal HTML bot page; Hono maps `HEAD /` to that route and removes the body. Hono's method-not-allowed middleware returns an empty `405` response with `Allow: GET, HEAD` for other methods at `/`, and the custom not-found handler returns an empty `404` response for every other pathname. Query parameters do not change route matching.

In production, this Worker is the Custom Domain origin. More specific Cloudflare Worker Routes execute first and preserve independently deployed product endpoints such as `/github/webhooks`.

## Webhook Worker flow

`workers/cyspbot-github-webhook-receiver/src/worker.ts` exposes only `POST /github/webhooks`. It rejects unknown routes and other methods before calling `handleGitHubWebhookRequest`.

`acceptGitHubWebhookDelivery` then:

1. resolves `GITHUB_WEBHOOK_SECRET` from a direct Worker secret or Secrets Store binding;
2. requires `application/json` and reads at most `256 KiB`;
3. requires the event, delivery, signature, and installation-target headers;
4. requires the target type `integration` and the configured `GITHUB_APP_ID`;
5. verifies the exact bytes with HMAC-SHA256;
6. parses the authenticated body as JSON; and
7. returns the acknowledgement shape for ping or other events.

The operation does not retain bodies, deduplicate delivery IDs, or dispatch event-specific handlers.

## Runtime bindings

- `GITHUB_APP_ID`: required non-secret variable used to bind deliveries to the intended GitHub App.
- `GITHUB_WEBHOOK_SECRET`: required Worker secret or Cloudflare Secrets Store binding.

The public Worker Wrangler files declare only local-development and dry-run values. Production domains, routes, resource identifiers, and secret-store references belong to the separate deployment repository.

## Tests and validation

The unit project exercises the root response, empty fallback response, bounded body reading, request-body size and status handling, signature/target validation, response mapping, and both Worker factories. Separate Workerd integration projects load each Worker's real Wrangler configuration and entrypoint.

Use Node 24 and the pinned pnpm version:

```bash
fnm exec --using=24 corepack pnpm run check
fnm exec --using=24 corepack pnpm run test:coverage
```

`check` verifies the frozen lockfile, formatting, generated environment types, lint, TypeScript, Knip, unit and integration tests, and both Workers' Wrangler deploy dry runs.
