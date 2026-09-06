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
