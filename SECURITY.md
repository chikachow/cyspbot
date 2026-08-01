# Security Policy

## Reporting Vulnerabilities

Please report security vulnerabilities privately through GitHub private vulnerability reporting when it is enabled for this repository.

If private vulnerability reporting is unavailable, contact the repository maintainer without opening a public issue. Do not include exploit details, private keys, tokens, webhook secrets, session material, or tenant-specific deployment identifiers in public issues, pull requests, or discussions.

## Security Boundary

cyspbot accepts Client-presented OpenID Connect ID Tokens from configured issuers and exchanges only the resulting Verified Subject Tokens for repository-scoped GitHub App installation access tokens. The Client is not authenticated and is not assumed to be the ID Token Subject. The important security properties are:

- issuer trust is configured, not discovered from Client-presented tokens
- the Verified Subject Token is derived only from signed claims in an ID Token accepted through an exact OIDC Provider Registration and, when non-null, its OIDC ID Token Profile
- the ID Token audience must be the exact single string `cyspbot`; the unsupported token-exchange `audience` parameter grants nothing
- the production application registers only GitHub Actions and Google; the Fly registration constructor uses an explicit null profile, and trusting any Fly issuer would require a reviewed checked-in application-composition change
- Google service account identity requires a service account ID Token from the Google Cloud IAM authorization server with Issuer Identifier `https://accounts.google.com`; its Authorized Party must equal its non-empty Subject, but the production Token Issuance Policy currently contains no Google Permit Statement
- Clients must supply exactly one effective canonical repository resource; value-less occurrences are omitted, and subject-token claims never select the target
- Clients may request an exact GitHub App permission scope
- checked-in Token Issuance Policy Permit Statements must compose Effective Permissions that cover the request for the Verified Subject Token and resource before a token is issued
- the GitHub App installation independently remains the upper bound on repositories and permissions
- the GitHub App private key remains inside the deployment secret boundary
- webhook processing requires GitHub signature validation before state changes
- webhook deliveries must identify the configured GitHub App before they are accepted

## Deployment Secrets

Never commit deployment secrets, local `.dev.vars`, `.env`, GitHub App private keys, webhook secrets, Cloudflare API tokens, or generated Wrangler state.

The source repository intentionally carries only public-safe Wrangler templates for local development, tests, and dry-runs. Production deployment details, credentials, secret values, and deployment overlays must stay outside this codebase.
