# Use a per-issuer verifier Durable Object for OIDC JWKS coordination

cyspbot will verify OIDC bearer tokens through one Durable Object per **Issuer Registration** instead of relying on isolate-local remote-JWKS caching alone. We chose this shape so each trusted issuer gets one coordinated refresh and backoff policy, one shared normalized JWKS snapshot, and one bounded stale-while-error policy across Worker isolates, while keeping issuer trust as static deployment configuration rather than token-driven discovery.

## Considered Options

- Keep verification entirely local in each Worker isolate with `jose` remote JWKS caching
- Use one global Durable Object for all issuers
- Route verification through one Durable Object per **Issuer Registration**

## Consequences

- cyspbot keeps future multi-issuer support open, but only through a closed set of configured **Issuer Registrations**
- The verifier Durable Object is on the critical path for token verification and therefore owns JWKS refresh, bounded stale serving, and refresh backoff for its issuer
- Unknown `kid` triggers one guarded refresh attempt; missing `kid` is an immediate verification failure
- Upstream JWKS cache headers are hints only and are clamped by cyspbot-owned freshness bounds
- Only fully validated, normalized, atomic JWKS snapshots may replace the current verifier state; invalid or partially usable documents are treated as refresh failures
