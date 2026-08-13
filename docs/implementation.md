# Implementation

## Workspace layout

cyspbot is a pnpm workspace with one deployable Cloudflare Worker:

- `workers/cyspbot-github-webhook-receiver` publishes `@cyspbot/github-webhook-receiver` and Worker `cyspbot-github-webhook-receiver`.

Shared packages:

- `packages/http` provides bounded body reading, request-body handling, JSON responses, and problem-details responses.
- `packages/github` provides the string-or-Secrets-Store secret-binding adapter used by webhook verification.

The root `wrangler.jsonc` points at `test/support/root-test-harness.ts`. It supplies common bindings to unit tests and is not a deployable product Worker.

## Worker flow

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

The public Worker Wrangler file declares only local-development and dry-run values. Production routes, resource identifiers, and secret-store references belong to the separate deployment repository.

## Tests and validation

The unit project exercises bounded body reading, request-body size and status handling, signature/target validation, response mapping, and the Worker factory. The Workerd integration project loads the webhook Worker's real Wrangler configuration and entrypoint and accepts a signed ping delivery.

Use Node 24 and the pinned pnpm version:

```bash
fnm exec --using=24 corepack pnpm run check
fnm exec --using=24 corepack pnpm run test:coverage
```

`check` verifies the frozen lockfile, formatting, generated environment types, lint, TypeScript, Knip, unit and integration tests, and the webhook Worker's Wrangler deploy dry run.
