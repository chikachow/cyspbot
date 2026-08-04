# Contributing

Keep changes small, explicit, and grounded in the service contract.

Before opening a pull request:

1. Run `pnpm install --frozen-lockfile`.
2. Run `node --run check`.
3. Update `docs/service-contract.md` when externally observable behaviour changes.
4. Update `docs/implementation.md` when package layout, Worker entrypoints, request flow, or bindings change.
5. Update `docs/deployment.md` and `docs/release.md` when source/deployment ownership or publish-readiness checks change.
6. Update `CONTEXT.md` when terminology or trust-boundary language changes.

Do not commit local deployment state or secrets. In particular, keep `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, GitHub App private keys, Cloudflare tokens, and webhook secrets out of commits.

Use present-tense documentation for implemented behaviour.

Decision records may also document source-supported capabilities that are not
currently configured in production. Label capability statements explicitly and
use conditional language; use `docs/service-contract.md` for the current
production registration and Token Issuance Policy inventory. Do not treat a
clearly labelled capability as a configured policy.
