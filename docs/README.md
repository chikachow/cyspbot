# cyspbot Documentation

This directory documents the current cyspbot implementation and public service contract.

## Documents

- [Service contract](service-contract.md) is reference material for the public API, security boundaries, and externally observable behaviour.
- [Implementation](implementation.md) explains the workspace packages, Worker entrypoints, request flows, bindings, and verification commands.
- [Deployment](deployment.md) explains the source repository boundary and confirms deployment is handled outside this codebase.
- [OIDC ID Token authentication decision](decisions/oidc-id-token-authentication.md) records the durable trust, discovery, and configuration-ownership rationale behind the implementation.
- [CEL-free Token Issuance Policy decision](decisions/cel-free-token-issuance-policy.md) records the closed authorization language, permission composition, and verified-Claim trust decisions.
- [GitHub API Failure Classification decision](decisions/github-api-failure-classification.md) records how service-owned credentials, ambiguous upstream failures, rate limits, and transport failures map to OAuth responses.
- [Release checklist](release.md) is a publish-readiness checklist to run before making the repository public or tagging a release.
- [Repository README](../README.md) is the setup and local development entrypoint.
- [Domain glossary](../CONTEXT.md) defines project terminology used by the code and docs.

## Unsupported Behaviour

Current implementation:

- OAuth token exchange at `POST /token`
- signed webhook acknowledgement at `POST /github/webhooks`
- deployable Cloudflare Worker packages under `workers/*`

cyspbot does not implement:

- Client-selected arbitrary repositories
- Client-supplied raw GitHub permissions
- Client-defined GitHub permission profiles or aliases
- multi-audience subject tokens or multi-resource token requests
- actor-token delegation or client-authenticated token exchange
- dynamic issuer discovery from untrusted tokens
- raw webhook payload archival or replay
- product-specific webhook event processing
