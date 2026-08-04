# Security Policy

## Reporting Vulnerabilities

Please report security vulnerabilities privately through GitHub private vulnerability reporting when it is enabled for this repository.

If private vulnerability reporting is unavailable, contact the repository maintainer without opening a public issue. Do not include exploit details, private keys, tokens, webhook secrets, session material, or tenant-specific deployment identifiers in public issues, pull requests, or discussions.

## Security Boundary

cyspbot accepts Client-presented OpenID Connect ID Tokens from configured issuers and exchanges only the resulting Verified Subject Tokens for repository-scoped GitHub App installation access tokens. The Client is not authenticated and is not assumed to be the ID Token Subject. The important security properties are:

- issuer trust is configured, not discovered from Client-presented tokens
- the Verified Subject Token is derived only from Subject Token Claims in an ID Token accepted through an exact OIDC Provider Registration and, when non-null, its OIDC ID Token Profile
- the ID Token audience must be the exact single string `cyspbot`; the unsupported token-exchange `audience` parameter grants nothing
- OIDC Provider Registrations and Permit Statements are independent, checked-in trust decisions; registration authenticates tokens but never authorizes Installation Access Token Issuance
- the [service contract](docs/service-contract.md) solely owns the exact production registration and Permit Statement inventory and all externally observable behaviour; the [implementation reference](docs/implementation.md) describes only module and runtime mechanics
- Clients must supply exactly one effective canonical Repository Resource; value-less occurrences are omitted, and Subject Token Claims never select the target
- Clients may name structurally valid GitHub permissions, but every Requested Permission must be covered by checked-in Permit Statements
- checked-in Token Issuance Policy Permit Statements must compose Effective Permissions that cover the Requested Permissions for the Verified Subject Token and Repository Resource before a token is issued
- the GitHub App installation independently remains the upper bound on repositories and permissions
- the GitHub App private key remains inside the deployment secret boundary
- webhook processing requires GitHub signature validation before state changes
- webhook deliveries must identify the configured GitHub App before they are accepted

## Deployment Secrets

Never commit deployment secrets, local `.dev.vars`, `.env`, GitHub App private keys, webhook secrets, Cloudflare API tokens, or generated Wrangler state.

The source repository intentionally carries only public-safe Wrangler templates for local development, tests, and dry-runs. Production deployment details, credentials, secret values, and deployment overlays must stay outside this codebase.
