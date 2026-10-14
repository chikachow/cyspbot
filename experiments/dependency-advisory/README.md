# Dependency advisory pilot

A manually invoked, read-only GitHub advisory for `chikachow/cyspbot`. It reports a candidate when the complete change fits the supported dependency structure, every direct declaration update is a stable nonzero-major patch, verified CI jobs passed for the head, and native peer/engine checks passed without changing the submitted lockfile. It does not approve or merge PRs and is not wired into webhook processing.

## Run

Use Node 24, authenticated GitHub CLI access, Python 3, Corepack and network access to GitHub and the npm registry. On macOS with Keychain-backed `gh`, authenticated commands need access to the Keychain. Output directories must be new. Treat output as private repository evidence; `.advisory/` is ignored.

```sh
mkdir -p .advisory
pnpm run advisory:collect chikachow/cyspbot .advisory/observation PR_NUMBER
pnpm run advisory:native .advisory/observation/PR_NUMBER.observation.json .advisory/native
pnpm run advisory:test
```

The collector creates factual Markdown cards and complete JSON observations. The native runner adds a check receipt, a final observation and an updated advisory card. Supply only observations produced by this trusted collector. Hashes bind local inputs; they do not authenticate arbitrary observation or receipt files. A saved candidate is a dated observation, never reusable merge authorization.

## Policy and evidence

All package names and declaration sections receive the same rule. Manifest additions/removals, section moves, source/range-operator changes, mixed code/config edits and unsupported lockfile fields require judgment. Major/minor, version-zero, prerelease, downgrade and lock-only changes remain reported but are outside the pilot's candidate category. Exact versions and unchanged simple `^`/`~` operators are supported.

The structural parser supports pnpm lockfile format 9. It rejects ambiguous JSON/YAML, inventories every changed field and preserves full semantic operations. It reports direct declarations, importer resolution transitions and added/removed package-version inventories. A complete manifest-only update can match; native tooling must then validate its unchanged lockfile. The policy does not reconstruct an expected update or use package-name allowlists. Valid additional transitive changes need not be minimal or caused solely by a direct bump; package metadata authenticity is not established.

The GitHub collector cross-checks the complete tree delta against the paginated changed-file inventory and verifies blob hashes. Required `ci` check provenance comes from branch rules. The policy additionally requires the eight named CI jobs in `advisory.mjs`, successful conclusions, matching head/app/suite/run/attempt, an unchanged workflow definition and a stable observation. Missing, skipped, neutral, failed and pending results block a candidate. CI is associated with the reported head; the actual tested merge base is not independently attested, and other repository merge rules are not implemented here.

Native validation requires the submitted `.nvmrc` to match Node 24 and uses the head's exact pnpm 10 pin. It checks strict peers with resolution-only mode and engines with actual frozen installation. Each starts from the submitted lockfile; both must preserve it. It disables lifecycle scripts and pnpmfile hooks, isolates user/global npm configuration, records versions/configuration/output hashes, and removes the temporary checkout/store afterward. It refreshes the PR and CI after validation and rejects changed head/base or CI evidence.

This is trusted local experimental code, not a hardened sandbox for arbitrary repository configuration. Review effective package-manager configuration before running it on an unfamiliar repository; the pilot intentionally accepts only this repository. Native validation reflects the runner's platform and declared package constraints, not exhaustive compatibility. Passing checks still permits ordinary patch regressions.

## Review and pilot boundaries

The test suite covers unsupported and missing change evidence, manifest/lockfile structure, wrong/stale CI identities, pending reruns, incomplete native receipts, input tampering and version classification. These are correctness checks, not a measured acceptance-error rate. Initial development runs demonstrated the path on a real PR, but those dated receipts and research datasets are not shipped with this implementation.

For the prospective pilot, retain every selected PR and collection failure, obtain maintainer judgments before showing predictions, and measure unsupported recommendations, useful coverage, blocked prerequisites and review time. Keep repeated heads grouped by PR. Natural editorial changes and model prompting are a separate experiment; no inference service or credentials are needed here. Continue advisory operation until the evidence and acceptance threshold justify a production integration.
