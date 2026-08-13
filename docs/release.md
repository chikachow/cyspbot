# Public release checklist

## Source tree

- `git status --short` shows only intentional changes.
- Ignored local files have been reviewed and are excluded from artifacts.
- Release artifacts are built from tracked source files.
- No `.dev.vars`, `.env`, `.wrangler/`, dependency directory, webhook secret, Cloudflare credential, or generated local state is included.
- `fnm exec --using=24 corepack pnpm run check` passes.
- `fnm exec --using=24 corepack pnpm run test:coverage` passes.

## Documentation and boundaries

- `README.md` describes cyspbot as a webhook receiver only.
- `docs/service-contract.md` matches the implemented webhook behavior.
- `docs/implementation.md` matches the packages, entrypoint, bindings, tests, and checks.
- `docs/deployment.md` matches the public-source and deployment-repository boundary.
- `CONTEXT.md` matches the webhook domain language.

## Repository settings

- GitHub secret scanning and push protection are enabled.
- Dependabot security updates are enabled.
- The protected branch requires the aggregate `ci` check.
- Private vulnerability reporting is enabled when available.
