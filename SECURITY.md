# Security Policy

## Reporting vulnerabilities

Please report security vulnerabilities privately through GitHub's private vulnerability reporting feature. Do not open a public issue containing exploit details, webhook secrets, payloads, or deployment credentials.

## Security boundary

cyspbot accepts GitHub App webhook deliveries. The important security properties are:

- request bodies are bounded to `256 KiB` before parsing;
- the delivery target must be the configured GitHub App ID;
- the exact request body must authenticate under `X-Hub-Signature-256` and the configured webhook secret;
- the authenticated body must be valid JSON before acknowledgement;
- raw webhook bodies, webhook secrets, workload identity assertions, and issued tokens are not logged or retained;
- only authenticated, newly created `/cyspbot status` comments produce a minimal versioned Status Reaction Job;
- the receiver awaits durable queue publication before acknowledging a matching command;
- only trusted producers may write to the queue, and the processor validates each job before requesting a token;
- the processor requests `issues:write pull_requests:write` for one repository and uses the issued token to add an `eyes` reaction; and
- the external broker owns workload identity verification and token issuance policy. Queue access and broker policy are deployment-owned trust controls.

The receiver does not filter repositories or comment authors. The broker must authorize the processor's workload identity and requested repository/permissions. Webhook target headers are routing metadata; authenticity depends on the body signature and a secret dedicated to the configured GitHub App. Repeated deliveries are allowed, and successful reaction creation or an existing reaction completes the job.

## Deployment secrets

Never commit deployment secrets, local `.dev.vars`, `.env`, webhook secrets, Cloudflare API tokens, or generated Wrangler state.

The webhook receiver needs:

- `GITHUB_APP_ID`, a non-secret Worker variable; and
- `GITHUB_WEBHOOK_SECRET`, supplied by a Worker secret or Cloudflare Secrets Store.

The cyspbot Worker serves both the root page and the Token Endpoint Proxy, so
its runtime is trusted with incoming identity tokens and outgoing access tokens.
Keep forwarding isolated from root-page handling; configuration failures affect
only `/token`. It forwards only to a deployment-owned canonical HTTPS
App URL through the required `GITHUB_APP_TOKEN_BROKER` HTTP Service Binding,
without caching, retries, public-fetch fallback, or token logging. The binding
selects the broker Worker; the configured URL selects its App path. Both are
trusted deployment configuration. This binding targets the default HTTP handler,
not the GitHub App Information RPC or Workload Identity issuer. It does not grant
access to signing keys, the ability to mint workload assertions, or token issuance
authority. The broker authenticates the supplied subject token and applies its
App-specific Token Issuance Policy independently of transport.

The proxy rejects all upstream 3xx responses without forwarding their headers or
bodies, preventing those responses from directing clients to replay subject tokens
elsewhere. Incoming `Host` is discarded and incoming query parameters cannot
change the configured URL. The proxy preserves `CF-Connecting-IP`, sets
`x-real-ip` from it, and removes `x-real-ip` when that identity is absent. Public
ingress must replace client-supplied `CF-Connecting-IP`; direct Worker and Service
Binding callers must be trusted. Do not substitute untrusted `X-Forwarded-For`.

The broker uses `CF-Connecting-IP` only for admission rate limiting, with a shared
`unknown` key when absent. A trusted binding caller can supply this header; the
binding does not authenticate it as an original client address. A compromised
caller can manipulate admission keys, but still needs a valid subject token and
an authorized request to obtain a token. The service-wide binding is not scoped
to one App; fixed App selection is enforced by the proxy code. The root runtime
already handles incoming assertions and outgoing tokens and must be trusted with
both.

Service Binding calls reach the Worker directly, so public-host routing and edge
controls must not be assumed to protect that hop. The broker's own admission,
OIDC authentication, and Token Issuance Policy remain mandatory. Local fixtures
and synthetic remote-binding probes establish header transport only. Production
verification must check the complete public ingress path and resistance to
client-supplied identity headers before claiming per-client admission behavior.
