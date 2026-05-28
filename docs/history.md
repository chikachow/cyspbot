# Suggested Public History

If this codebase is republished with a blank history, split it into reviewable commits that tell the product story in dependency order.

1. `chore(project): scaffold worker typescript runtime`
   - package manager, TypeScript config, formatter, linter, Wrangler test config, and CI
2. `feat(oidc): verify trusted github actions issuers`
   - issuer registry, JWKS fetching and validation, verifier state, Durable Object coordination, and OIDC tests
3. `feat(github): authenticate app and resolve installations`
   - GitHub App JWT signing, private-key loading, REST client, installation lookup, and installation token creation
4. `feat(policy): enforce installation token issuance rules`
   - token policy, default-branch/event restrictions, permission request shape, and policy tests
5. `feat(worker): expose token exchange and claims routes`
   - `/token`, `/github/claims`, OAuth error shape, problem details, and route tests
6. `feat(storage): add d1 audit and reconciliation state`
   - D1 migrations, audit intent and finalization, issued-token facts, and reconciliation signal state
7. `feat(webhook): accept signed github app deliveries`
   - signature validation, payload limits, delivery log metadata, and Durable Object reconciliation signaling
8. `feat(dashboard): add github user authorization sessions`
   - OAuth login, callback, logout, encrypted dashboard sessions, and cookie controls
9. `feat(dashboard): render repository audit views`
   - GitHub user-to-server repository visibility, dashboard list and detail pages, and authorization tests
10. `feat(pull-request-haiku): add opt-in webhook comment worker`
    - feature flag, admin opt-in UI, queue, Workers AI generation, and comment create/update flow
11. `docs: document service contract and decisions`
    - README, service contract, glossary, and ADRs aligned to implemented behaviour
12. `chore(release): prepare public repository`
    - license, security policy, contribution guide, dependency automation, deployment split, and release checklist
