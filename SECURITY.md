# Security Policy

## Reporting Vulnerabilities

Please report security vulnerabilities privately through GitHub private vulnerability reporting when it is enabled for this repository.

If private vulnerability reporting is unavailable, contact the repository maintainer without opening a public issue. Do not include exploit details, private keys, tokens, webhook secrets, session material, or tenant-specific deployment identifiers in public issues, pull requests, or discussions.

## Security Boundary

cyspbot exchanges verified GitHub Actions OIDC tokens for repository-scoped GitHub App installation access tokens. The important security properties are:

- issuer trust is configured, not discovered from caller-controlled tokens
- the calling repository is derived from verified OIDC claims
- callers cannot choose repositories or permission profiles
- the GitHub App private key remains inside the deployment secret boundary
- webhook processing requires GitHub signature validation before state changes
- webhook deliveries must identify the configured GitHub App before they are accepted

## Deployment Secrets

Never commit deployment secrets, local `.dev.vars`, `.env`, GitHub App private keys, webhook secrets, Cloudflare API tokens, or generated Wrangler state.

The source repository intentionally carries only public-safe Wrangler templates for local development, tests, and dry-runs. Production deployment details, credentials, secret values, and deployment overlays must stay outside this codebase.
