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
- dashboard repository visibility is delegated to GitHub user-to-server installation APIs

## Deployment Secrets

Never commit deployment secrets, local `.dev.vars`, GitHub App private keys, webhook secrets, Cloudflare API tokens, dashboard session secrets, or generated Wrangler state.

The current repository includes non-secret production deployment identifiers so it can deploy cyspbot directly. Before publishing the repository publicly, either move those identifiers to a private deployment repository or intentionally accept that they will be public. Deployment credentials and secret values must stay out of the repository.
