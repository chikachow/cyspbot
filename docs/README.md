# cyspbot Product Documentation

This directory separates current product facts from design history.

## Current Product Sources

- [Product specification](current-api-compatible-service-prd.md) is the primary current-state source. It defines the implemented API, dashboard, security, persistence, and acceptance contracts.
- [Dashboard and persistence reference](dashboard-d1-recut.md) is the detailed D1, dashboard, Audit Log, Webhook Delivery Log, and Installation Reconciliation state reference.
- [Repository README](../README.md) is the operational entrypoint for setup, local development, deployment, and direct GitHub Actions usage.
- [Domain glossary](../CONTEXT.md) defines the project vocabulary used in code reviews, design discussions, and future implementation work.

## Decision History

The ADRs capture decisions that led to the current state. They are historical records, not the first place to look up current route or schema behavior.

- [ADR 0001: Hosted GitHub installation token broker](adr/0001-hosted-github-installation-token-broker.md)
- [ADR 0002: Per-issuer JWKS verifier Durable Object](adr/0002-per-issuer-jwks-verifier-durable-object.md)
- [ADR 0003: Dashboard user authorization](adr/0003-dashboard-user-authorization.md)

## Roadmap Boundary

Current implementation:

- OAuth token exchange at `POST /token`
- claims verification at `POST /github/claims`
- signed webhook acceptance at `POST /github/webhooks`
- GitHub App user authorization dashboard at `GET /dashboard`
- D1-backed Audit Log, Dashboard Sessions, Webhook Delivery Log metadata, and reconciliation signal state

Future implementation:

- full Installation Reconciliation execution
- retry dispatch for reconciliation work
- retention cleanup jobs
- optional operator diagnostics for reconciliation failures
- optional dashboard usability enhancements over already-authorized data

Non-goals unless explicitly redesigned:

- caller-selected repositories
- caller-selected GitHub permission profiles
- dynamic issuer discovery from untrusted tokens
- raw webhook payload archival or cyspbot-local replay
- rearchitecting the security boundary for modernization alone
