# Implementation

## Workspace layout

cyspbot is a pnpm workspace with three deployable Cloudflare Workers:

- `workers/cyspbot` publishes `@cyspbot/cyspbot` and Worker `cyspbot`.
- `workers/cyspbot-github-webhook-receiver` publishes `@cyspbot/github-webhook-receiver` and Worker `cyspbot-github-webhook-receiver`.
- `workers/cyspbot-github-webhook-processor` publishes `@cyspbot/github-webhook-processor` and Worker `cyspbot-github-webhook-processor`.

Shared packages:

- `packages/http` provides bounded body reading, request-body handling, JSON responses, and problem-details responses.
- `packages/github` provides the string-or-Secrets-Store secret-binding adapter used by webhook verification.
- `packages/token-exchange` provides the internal RFC 8693 Token Exchange Client.
- `packages/github-webhook-jobs` provides the versioned job contract shared by the webhook receiver and processor.

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
6. parses the authenticated body as JSON;
7. classifies `issue_comment` deliveries with `action: "created"` and a trimmed comment body exactly equal to `/cyspbot status`;
8. sends the derived version-1 job to `GITHUB_WEBHOOK_JOBS` and waits for the queue write; and
9. returns the acknowledgement shape for ping, matching, or other events.

The receiver sends only a derived job to the queue. The job contains the kind, version, delivery ID, repository owner and name, and comment ID. The receiver does not apply repository filtering.

## Webhook processor flow

`workers/cyspbot-github-webhook-processor` consumes one message at a time from `cyspbot-github-webhook-jobs`. It validates the versioned job, requests a GitHub App Installation Access Token with `issues:write` for the canonical GitHub Repository Resource, and posts an `eyes` reaction to the comment. GitHub `200` and `201` responses complete the job.

Cloudflare Queues delivers messages at least once. Repeated jobs are safe because the GitHub reaction operation treats an existing reaction as success. The consumer retries network failures, HTTP `429`, HTTP `5xx`, and rate-limited HTTP `403` responses. It acknowledges permanent failures, retries five times with a 60-second delay, and sends exhausted jobs to `cyspbot-github-webhook-jobs-dlq`.

## Runtime bindings

- `GITHUB_APP_ID`: required non-secret variable used to bind deliveries to the intended GitHub App.
- `GITHUB_WEBHOOK_SECRET`: required Worker secret or Cloudflare Secrets Store binding.
- `GITHUB_WEBHOOK_JOBS`: Queue producer binding used by the webhook receiver for derived status-reaction jobs.
- `cyspbot-github-webhook-processor` consumes `cyspbot-github-webhook-jobs` and sends exhausted jobs to `cyspbot-github-webhook-jobs-dlq`.
- `WORKLOAD_IDENTITY_ISSUER`: RPC Service Binding to a separately deployed
  `WorkloadIdentityIssuer` entrypoint. Its `issueToken(audience)` operation
  returns an `IssuedToken`; the issuer deployment owns the workload subject
  and signing details. This RPC is a workload-identity interface, not an OAuth
  token endpoint.
- `WORKLOAD_IDENTITY_TOKEN_AUDIENCE`: non-secret Worker variable containing the
  logical audience requested from the issuer and accepted by the broker.
- `GITHUB_APP_TOKEN_BROKER`: Service Binding used by the OAuth Client to call
  the broker's existing RFC 8693 Token Endpoint with `fetch`.
- `GITHUB_APP_TOKEN_BROKER_TOKEN_ENDPOINT`: non-secret Worker variable
  containing the broker's token endpoint URL. It is separate from the logical
  Workload Identity Token audience.

The internal Token Exchange Client in `packages/token-exchange` first calls the issuer RPC, then posts the
returned short-lived Workload Identity Token as a workload identity assertion
to the configured broker endpoint as the RFC 8693 `subject_token` under the
broker's OIDC ID Token subject-token profile. It requests a GitHub App
Installation Access Token with a canonical GitHub `resource` and explicit permission
`scope`; the broker remains the source of truth for normalization, OIDC ID
Token profile verification, and Token Issuance Policy. On success, the client
returns a `GitHubAppInstallationAccessToken`. On an OAuth failure, it throws a
`GitHubAppTokenBrokerError` containing the HTTP status and OAuth error code and
description. Workload identity assertions and issued GitHub tokens must not be
logged.

The client is an internal library operation and is not exposed as an HTTP
route. Production service names, identity properties, domains, routes,
resource identifiers, secret-store references, and Cloudflare Workload Identity
properties belong to the separate deployment repository. The public Worker
Wrangler files contain only local-development and dry-run service targets and
values.

## Tests and validation

The unit project exercises the root response, bounded body reading, request-body size and status handling, signature/target validation, queue-job classification and processing, token-exchange response mapping, and all Worker factories. Separate Workerd integration projects load each Worker's real Wrangler configuration and entrypoint.

The cyspbot integration project runs a local `WorkloadIdentityIssuer`
named-entrypoint fixture through a Workerd Service Binding and exercises the
client's RPC call. This validates the local RPC serialization and method
contract; it does not test the separately deployed issuer implementation. The
unit project uses structural fixtures for validation failures.

Use Node 24 and the pinned pnpm version:

```bash
fnm exec --using=24 corepack pnpm run check
fnm exec --using=24 corepack pnpm run test:coverage
```

`check` verifies the frozen lockfile, formatting, generated environment types, lint, TypeScript, Knip, unit and integration tests, and all three Workers' Wrangler deploy dry runs.
