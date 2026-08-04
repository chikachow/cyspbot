# cyspbot

cyspbot is a hosted Security Token Service for trusted automation workloads. It
exchanges an authorized OpenID Connect ID Token for a short-lived,
repository-scoped GitHub App Installation Access Token without exposing the
GitHub App private key outside Cloudflare.

## Documentation

The [documentation map](docs/README.md) indexes the project documentation and
defines which document owns each kind of fact. For client integration, start
with the [Token Exchange section of the service
contract](docs/service-contract.md#token-exchange). For source navigation and
runtime details, use the [implementation reference](docs/implementation.md).

## Architecture

- `workers/cyspbot-token-exchange` publishes `@cyspbot/token-exchange` and
  Worker `cyspbot-token-exchange` for `POST /token`.
- `workers/cyspbot-github-webhook-receiver` publishes
  `@cyspbot/github-webhook-receiver` and Worker
  `cyspbot-github-webhook-receiver` for `POST /github/webhooks`.
- `packages/*` contains the shared HTTP, GitHub App, OpenID Connect, and
  provider-registration implementation.
- The root `wrangler.jsonc` is a local/test binding harness, not a deployable
  Worker.

## Local development

1. Copy `.dev.vars.example` to `.dev.vars`.
2. Set the GitHub App ID, webhook secret, and local PKCS#8 PEM private key.
3. Install dependencies and run the full repository check:

   ```bash
   pnpm install
   node --run check
   ```

4. Start both Workers locally:

   ```bash
   pnpm run dev
   ```

   Or start one Worker:

   ```bash
   pnpm --filter @cyspbot/token-exchange run dev
   pnpm --filter @cyspbot/github-webhook-receiver run dev
   ```

The workspace requires Node 24 and pnpm 10.33.0. Each Worker generates its
runtime types immediately before type-checking; the checked-in Env types allow
the combined test project to reference both Worker environments.

Do not commit `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, Cloudflare
tokens, deployment overlays, or GitHub App key material. See the
[deployment guide](docs/deployment.md) and [release checklist](docs/release.md)
for the source and artifact safety boundary.

## GitHub Actions clients

Workflows that request a GitHub Actions OIDC token need:

```yaml
permissions:
  id-token: write
```

That permission alone does not authorize an Installation Access Token. The
[service contract](docs/service-contract.md#token-issuance-policy) defines the
configured Token Issuance Policy and client-facing requirements. The reusable
action lives in the separate `cyspbot-app-token-action` repository.

## Repository workflows

The `ci` workflow validates formatting, generated Env types, linting,
type-checking, Knip, tests, and Worker deploy dry-runs. The
`run-cyspbot-deploy-update` workflow triggers the separate deployment
repository only after successful CI on `main`; production deployment secrets
and workflows do not live here.
