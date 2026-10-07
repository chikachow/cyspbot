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

The dedicated Token Endpoint Proxy Worker is trusted with incoming identity tokens
and outgoing access tokens. It forwards only to a deployment-owned HTTPS canonical
App path using HTTPS, without caching, retries, or token logging. It rejects all
upstream 3xx responses without forwarding their headers or bodies, preventing
those responses from directing clients to replay subject tokens elsewhere.
The configured URL determines the destination; incoming `Host` is discarded.
The proxy sets `x-real-ip` from edge-supplied `CF-Connecting-IP` and removes it
when that identity is absent. Public ingress must replace client-supplied
`CF-Connecting-IP`; direct Worker callers must be trusted.

For same-zone Worker subrequests, Cloudflare derives `CF-Connecting-IP` from
`x-real-ip`. For cross-zone subrequests to another Cloudflare zone, Cloudflare
replaces it with a shared Worker address, so broker admission becomes shared
across those requests. Cross-account HTTPS works but does not preserve per-client
admission identity. Do not substitute untrusted `X-Forwarded-For`. See
[Cloudflare's request-header behavior](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip).
The broker authenticates and authorizes every exchange independently of transport.
