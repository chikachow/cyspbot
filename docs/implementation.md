# Implementation

## Workspace layout

cyspbot is a pnpm workspace with three deployable Cloudflare Workers:

- `workers/cyspbot` publishes `@cyspbot/cyspbot` and Worker `cyspbot`.
- `workers/cyspbot-github-webhook-receiver` publishes `@cyspbot/github-webhook-receiver` and Worker `cyspbot-github-webhook-receiver`.
- `workers/cyspbot-github-webhook-processor` publishes `@cyspbot/github-webhook-processor` and Worker `cyspbot-github-webhook-processor`.

Shared packages:

- `packages/http` provides bounded body reading, request-body handling, JSON responses, and problem-details responses.
- `packages/token-exchange` provides the internal RFC 8693 Token Exchange Client.
- `packages/github-webhook-jobs` provides the versioned job contract shared by the webhook receiver and processor.

The root `wrangler.jsonc` points at `test/support/root-test-harness.ts`. It supplies common bindings to unit tests and is not a deployable product Worker.

## Root Worker flow

`workers/cyspbot/src/worker.ts` uses a native fetch handler. It returns the minimal HTML bot page for `GET /` and the same status and headers without a body for `HEAD /`. Other methods at `/` receive an empty `405` response with `Allow: GET, HEAD`; other pathnames receive an empty `404`. Query parameters do not change route matching.

In production, this Worker is the Custom Domain origin. More specific Cloudflare Worker Routes execute first and preserve independently deployed product endpoints such as `/github/webhooks`.

## Webhook Worker flow

`workers/cyspbot-github-webhook-receiver/src/worker.ts` exposes only `POST /github/webhooks`. It rejects unknown routes and other methods before calling `handleGitHubWebhookRequest`.

`handleGitHubWebhookRequest` owns the HTTP response and privately authenticates the envelope. It:

1. resolves `GITHUB_WEBHOOK_SECRET` from a direct Worker secret or Secrets Store binding;
2. requires `application/json` and reads at most `256 KiB`;
3. requires the event, delivery, signature, and installation-target headers;
4. requires the target type `integration` and the configured `GITHUB_APP_ID`;
5. verifies the exact bytes and decoded signature with Web Crypto HMAC-SHA256 verification;
6. parses the authenticated body as JSON;
7. classifies `issue_comment` deliveries with `action: "created"` and a trimmed comment body exactly equal to `/cyspbot status`;
8. sends the derived version-1 job to `GITHUB_WEBHOOK_JOBS` and waits for the queue write; and
9. returns the acknowledgement shape for ping, matching, or other events.

The receiver resolves direct secrets and Secrets Store bindings through its private secret adapter.

The receiver sends only a derived job to the queue. The job contains the kind, version, delivery ID, repository owner and name, and comment ID. The receiver uses the same job parser as the processor to validate the projected job before publication. It does not apply repository authorization filtering.

## Webhook processor flow

`workers/cyspbot-github-webhook-processor` consumes one message at a time from `cyspbot-github-webhook-jobs`. It validates the versioned job, requests a GitHub App Installation Access Token with `issues:write pull_requests:write` for the canonical GitHub Repository Resource, and posts an `eyes` reaction to the comment. GitHub `200` and `201` responses complete the job.

Cloudflare Queues delivers messages at least once. Repeated jobs are safe because the GitHub reaction operation treats an existing reaction as success. The consumer retries network failures, HTTP `429`, HTTP `5xx`, and rate-limited HTTP `403` responses. It acknowledges permanent failures, retries up to five times, and sends exhausted jobs to `cyspbot-github-webhook-jobs-dlq`. GitHub HTTP error responses honor server waiting hints or use exponential backoff starting at 60 seconds, bounded to 24 hours; other transient failures use the queue's 60-second default.

## Runtime bindings

- `GITHUB_APP_ID`: required non-secret variable used to bind deliveries to the intended GitHub App.
- `GITHUB_WEBHOOK_SECRET`: required Worker secret or Cloudflare Secrets Store binding.
- `GITHUB_WEBHOOK_JOBS`: Queue producer binding used by the webhook receiver for derived status-reaction jobs.
- `cyspbot-github-webhook-processor` consumes `cyspbot-github-webhook-jobs` and sends exhausted jobs to `cyspbot-github-webhook-jobs-dlq`. GitHub HTTP error responses honor server waiting hints or use exponential backoff starting at 60 seconds, bounded to 24 hours; other transient failures use the queue's 60-second default.
- The processor's `WORKLOAD_IDENTITY_ISSUER`: RPC Service Binding to a separately deployed
  `WorkloadIdentityIssuer` entrypoint. Its `issueToken(audience)` operation
  returns an `IssuedToken`; the issuer deployment owns the workload subject
  and signing details. This RPC is a workload-identity interface, not an OAuth
  token endpoint.
- The processor's `WORKLOAD_IDENTITY_TOKEN_AUDIENCE`: non-secret Worker variable containing the
  logical audience requested from the issuer and accepted by the broker.
- The processor's `GITHUB_APP_TOKEN_BROKER`: Service Binding used by the OAuth Client to call
  the broker's existing RFC 8693 Token Endpoint with `fetch`.
- The processor's `GITHUB_APP_TOKEN_BROKER_TOKEN_ENDPOINT`: non-secret Worker variable
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

Tests live in each owning package or Worker’s `test/` directory alongside `src/`. Worker integration tests and their fixtures live under `test/integration/`; helpers shared by tests within a Worker live under its `test/support/`. The root `test/` contains the shared unit harness, its own test, and integration tests spanning multiple Workers. Tests use local source imports for internal seams and package imports for package interfaces and dependencies. Worker package exports expose only their entrypoints.

The root `vitest.config.ts` selects the unit suite, three Worker integration suites, and the built-Worker integration suite, and owns combined coverage. Production TypeScript checks and the Node-import lint restriction apply to `src/`; the root test TypeScript configuration also covers package-local tests and their helpers. CI retains separate validation workflows.

The unit and individual Worker integration suites run in Workerd through `@cloudflare/vitest-plugin` with Vitest 5. Vite is an explicit development dependency, and Vitest and its Istanbul coverage provider use matching versions. The published Cloudflare plugin currently requires the version-specific compatibility patch described in [patches/README.md](../patches/README.md). pnpm enforces peer dependencies, and Dependabot groups the Cloudflare SDK, Vite, and Vitest updates together. Inline Vitest projects inherit the root prohibition on focused tests. Coverage explicitly includes package and Worker source files, including files not imported by tests, and excludes type declarations. Each Worker's production TypeScript check uses the runtime types generated from its Wrangler compatibility date and flags.

The unit project exercises the root response, bounded body reading, request-body size and status handling, signature/target validation through HTTP responses, queue-job classification and processing, token-exchange response mapping, and all Worker factories. Separate Workerd integration projects load each Worker's real Wrangler configuration and entrypoint.

The processor integration project loads the processor Wrangler configuration,
runs a local `WorkloadIdentityIssuer` named-entrypoint fixture through a
Workerd Service Binding, and exercises the queue entrypoint's token exchange.
The test checks the broker request, exact GitHub token use, and queue acknowledgement or retry through Cloudflare message-batch helpers. This validates the local RPC serialization and method contract; it does not test
the separately deployed issuer implementation. The unit project uses
structural fixtures for validation failures.

The `built-workers-integration` project runs in Node and uses Wrangler's
`createTestHarness()` to build and run all three Workers with their production
compatibility dates and flags. It checks the root page, bodyless responses for
HEAD, unsupported methods and unknown paths, and rejection of matching webhooks
with an invalid signature or installation target. It sends signed Webhook
Deliveries through the receiver's configured queue to the processor and exercises
GitHub's success responses for both new and existing reactions.
Local issuer and broker fixtures validate the token exchange; a Node `fetch`
mock validates the GitHub reaction request and blocks other outbound requests.
The queue connection uses the production Wrangler configurations. This suite
complements the individual processor tests that assert acknowledgement and retry
behavior. Built Worker code runs outside Vitest's coverage instrumentation.

Vitest's async-leak diagnostics use Node's `async_hooks`; Workerd does not
implement the hooks used by this detector. To investigate leaked resources in
the Node test harness, run:

```bash
node --run test -- --project built-workers-integration --detectAsyncLeaks
```

This diagnoses resources in the Node test process; it does not detect leaks
inside the Workers. Keep this slower diagnostic mode opt-in.

Use Node 24 and the pinned pnpm version:

```bash
fnm exec --using=24 corepack pnpm run check
fnm exec --using=24 corepack pnpm run test:coverage
```

`check` verifies the frozen lockfile, formatting, generated environment types, lint, TypeScript, Knip, unit and integration tests, and all three Workers' Wrangler deploy dry runs.
