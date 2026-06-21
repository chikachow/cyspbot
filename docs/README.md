# cyspbot Documentation

This directory documents the current cyspbot implementation and public service contract.

## Documents

- [Service contract](service-contract.md) is reference material for the public API, security boundaries, and externally observable behaviour.
- [Implementation](implementation.md) explains the workspace packages, Worker entrypoints, request flows, bindings, and verification commands.
- [Deployment](deployment.md) explains the source repository boundary and confirms deployment is handled outside this codebase.
- [Release checklist](release.md) is a publish-readiness checklist to run before making the repository public or tagging a release.
- [Repository README](../README.md) is the setup and local development entrypoint.
- [Domain glossary](../CONTEXT.md) defines project terminology used by the code and docs.

## Unsupported Behaviour

Current implementation:

- OAuth token exchange at `POST /token`
- signed webhook acknowledgement at `POST /github/webhooks`
- deployable Cloudflare Worker packages under `workers/*`

cyspbot does not implement:

- caller-selected arbitrary repositories
- caller-supplied raw GitHub permissions
- caller-defined GitHub permission profiles or aliases
- multi-resource token requests
- token-exchange `audience`, actor-token delegation, or client-authenticated token exchange
- dynamic issuer discovery from untrusted tokens
- raw webhook payload archival or replay
- product-specific webhook event processing
