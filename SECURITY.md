# Security Policy

## Reporting Vulnerabilities

Please report security vulnerabilities privately through GitHub private vulnerability reporting when it is enabled for this repository.

If private vulnerability reporting is unavailable, contact the repository maintainer without opening a public issue. Do not include exploit details, private keys, tokens, webhook secrets, session material, or tenant-specific deployment identifiers in public issues, pull requests, or discussions.

## Security Boundary

cyspbot accepts Caller-supplied OpenID Connect ID Tokens from configured issuers and exchanges only the resulting Verified Subject Tokens for repository-scoped GitHub App installation access tokens. The important security properties are:

- issuer trust is configured, not discovered from caller-controlled tokens
- the Verified Subject Token is derived only from signed claims in an ID Token issued by a configured issuer and accepted by that issuer's adapter
- the ID Token audience must be the exact single string `cyspbot`; the unsupported token-exchange `audience` parameter grants nothing
- each configured Fly.io organization has its own issuer adapter and Trusted OIDC Issuer; Fly Machine identity is bound to provider-assigned organization and Fly App IDs, the Fly Organization Slug, a stable Machine ID, a Machine name that participates in canonical Subject consistency, and a Machine configuration version required as signed Machine configuration-version context; neither the Machine name nor configuration version is a Token Policy selector
- callers may request one canonical repository resource and an exact GitHub App permission scope
- Token Policy must explicitly allow the Verified Subject Token, GitHub App, resource, and permission combination before a token is issued
- the GitHub App installation remains the upper-bound authority for repositories and permissions
- the GitHub App private key remains inside the deployment secret boundary
- webhook processing requires GitHub signature validation before state changes
- webhook deliveries must identify the configured GitHub App before they are accepted

## Deployment Secrets

Never commit deployment secrets, local `.dev.vars`, `.env`, GitHub App private keys, webhook secrets, Cloudflare API tokens, or generated Wrangler state.

The source repository intentionally carries only public-safe Wrangler templates for local development, tests, and dry-runs. Production deployment details, credentials, secret values, and deployment overlays must stay outside this codebase.
