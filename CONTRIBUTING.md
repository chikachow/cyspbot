# Contributing

Keep changes small, explicit, and grounded in the service contract.

Before opening a pull request:

1. Run `pnpm install --frozen-lockfile`.
2. Run `node --run check`.
3. Update `docs/service-contract.md` when externally observable behaviour changes.
4. Update `CONTEXT.md` when terminology or trust-boundary language changes.

Do not commit local deployment state or secrets. In particular, keep `.dev.vars`, `.wrangler/`, `.local-secrets/`, GitHub App private keys, Cloudflare tokens, webhook secrets, and dashboard session secrets out of commits.

Use present-tense documentation for implemented behaviour. Future work should be clearly labelled as future work.
