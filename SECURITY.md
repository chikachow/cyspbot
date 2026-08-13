# Security Policy

## Reporting vulnerabilities

Please report security vulnerabilities privately through GitHub's private vulnerability reporting feature. Do not open a public issue containing exploit details, webhook secrets, payloads, or deployment credentials.

## Security boundary

cyspbot accepts GitHub App webhook deliveries. The important security properties are:

- request bodies are bounded to `256 KiB` before parsing;
- the delivery target must be the configured GitHub App ID;
- the exact request body must authenticate under `X-Hub-Signature-256` and the configured webhook secret;
- the authenticated body must be valid JSON before acknowledgement;
- raw webhook bodies and secret values are not logged or retained; and
- event acceptance does not dispatch event-specific product behavior.

## Deployment secrets

Never commit deployment secrets, local `.dev.vars`, `.env`, webhook secrets, Cloudflare API tokens, or generated Wrangler state.

The webhook receiver needs:

- `GITHUB_APP_ID`, a non-secret Worker variable; and
- `GITHUB_WEBHOOK_SECRET`, supplied by a Worker secret or Cloudflare Secrets Store.
