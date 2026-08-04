# cyspbot Documentation

This directory indexes cyspbot documentation. Each document owns a distinct
kind of fact so that a change has one authoritative home.

## Documents

- [Service contract](service-contract.md) is the sole authority for the public API, security boundaries, externally observable behaviour, and current configured trust and authorization inventory.
- [Implementation](implementation.md) explains workspace packages, Worker entrypoints, request flows, runtime bindings, and verification commands; it does not define client-visible behaviour.
- [Deployment](deployment.md) explains the source repository boundary and confirms deployment is handled outside this codebase.
- [OIDC ID Token authentication decision](decisions/oidc-id-token-authentication.md) records the durable trust, discovery, and configuration-ownership rationale behind the implementation.
- [CEL-free Token Issuance Policy decision](decisions/cel-free-token-issuance-policy.md) records the closed authorization language, extensible permission names, permission-level composition, and trust in Subject Token Claims.
- [GitHub API Failure Classification decision](decisions/github-api-failure-classification.md) records how service-owned credentials, ambiguous upstream failures, rate limits, and transport failures map to cyspbot Token Endpoint responses.
- [Release checklist](release.md) is a publish-readiness checklist to run before making the repository public or tagging a release.
- [Repository README](../README.md) is the setup and local development entrypoint.
- [Domain glossary](../CONTEXT.md) defines project terminology used by the code and docs.

## Capability and Configured Policy

Decision records may describe capabilities that the source supports without
asserting that production currently configures those capabilities. Capability
statements use conditional language and identify themselves as capabilities.
The service contract owns the current production registration and Token
Issuance Policy inventory. A capability is not a configured policy merely
because an accepted decision documents it.
