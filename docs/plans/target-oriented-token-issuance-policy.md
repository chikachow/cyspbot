# Target-oriented Token Issuance Policy implementation plan

This plan implements [ADR 0001](../adr/0001-target-oriented-token-issuance-policy.md)
on top of the accepted and currently implemented
[CEL-free Token Issuance Policy](../decisions/cel-free-token-issuance-policy.md).
It is intentionally separate from the decision record so file names, interface
details, sequencing, and verification evidence can evolve without rewriting the
durable authorization decision.

## Starting point

Current `origin/main` already provides:

- `PermitStatementDefinition` with one exact OIDC Subject Token Constraint, one
  exact Repository Resource Constraint, and non-empty permissions;
- strict Claim Predicate factories and defensive compilation;
- an opaque immutable `TokenIssuancePolicy`;
- pointwise permission coverage ordered
  `omitted < read < write < admin`;
- additive composition across every applicable Permit Statement;
- Boolean authorization and separate Boolean target and Requested Permissions
  support queries;
- fail-fast OIDC Provider Registration coverage at application composition;
- a checked-in production policy with nine GitHub Actions statements; and
- permanent tests for composition, ordering, duplicate tolerance, defensive
  compilation, configured policy, integration, and issuance.

The implementation must extend this surface rather than recreate or replace it.

## Required result

After implementation:

1. Checked-in TypeScript can clearly expand one subject-token constraint and
   permission map over several explicit Repository Resource Constraints.
2. A narrower expansion can add permissions for an explicit subset.
3. Every evaluated element remains a complete `PermitStatementDefinition` with
   one exact resource.
4. A deterministic Target Policy View exposes every distinct normalized Permit
   Statement for one Repository Resource from the same compiled policy used by
   authorization.
5. A read-only command renders the production Target Policy View without
   network access.
6. Authorization, support classification, issuance, and logs remain unchanged.
7. No statement identifiers, contributor list, hierarchy, defaults, wildcard,
   target groups, provider-specific matcher layer, or second policy compiler are
   introduced.

## Implementation shape

### Token Issuance Policy interface

Extend
`workers/cyspbot-token-exchange/src/policy/token-issuance-policy.ts` with a
read-only description interface. The preferred initial shape is:

```ts
export interface TargetPolicyView {
  readonly permitStatements: readonly TargetPermitStatementDescription[];
  readonly resource: GitHubRepositoryResource;
}

export interface TargetPermitStatementDescription {
  readonly permissions: GitHubInstallationPermissions;
  readonly subjectToken: OidcSubjectTokenConstraintDefinition;
}

export function describeTokenIssuancePolicyTarget(
  policy: TokenIssuancePolicy,
  resource: GitHubRepositoryResource,
): TargetPolicyView | null;
```

Use the existing opaque policy and its private compiled statements. Do not add a
parallel policy object or require callers to retain the source definitions.

The implementation may retain the current private statement array or replace it
with a private representation containing both evaluation and inspection data.
That choice is internal. With the current small policy, a linear filter is
adequate; do not add a target index solely in anticipation of scale.

### Canonical description

Construct the description from compiled, validated values rather than the
caller-owned definition objects.

For each matching statement:

1. Copy the exact compiled issuer.
2. Copy its normalized Claim Predicates.
3. Sort Claim Predicates lexically by `claimName`.
4. For `claim-one-of`, sort `expectedValues` lexically because membership order
   is semantically irrelevant.
5. Copy canonical permissions with property insertion ordered lexically by
   permission name.
6. Deep-freeze the complete description.

Create a canonical comparison key from the normalized issuer, predicate AST,
and permissions. Use it to:

- eliminate exact canonical duplicates; and
- sort statement descriptions deterministically.

Do not attempt implication analysis. These remain distinct:

```text
event_name == workflow_dispatch
event_name in [schedule, workflow_dispatch]
```

They overlap, but neither is an exact duplicate of the other.

Return a canonical copy of the requested Repository Resource. Return `null`
when the compiled policy contains no statement for its exact `href`.

### Immutability and hostile inputs

The description operation is called with domain values, but it must retain the
same defensive behavior as the rest of the opaque policy interface:

- reject an object that is not a compiled `TokenIssuancePolicy` through the
  existing private lookup;
- never expose objects stored inside the compiler for later mutation;
- never invoke accessors from original definitions during inspection;
- never return mutable arrays, predicates, membership collections, permission
  maps, or resources; and
- perform no claim evaluation or network access.

### Checked-in authoring organization

Refactor
`workers/cyspbot-token-exchange/src/policy/configured-token-issuance-policy.ts`
only after the description interface is tested.

Keep `compileTokenIssuancePolicy()` as the only construction seam. Configuration
may be split into files beneath:

```text
workers/cyspbot-token-exchange/src/policy/configuration/
```

The exact grouping should follow maintained automation relationships rather
than providers or an artificial one-file-per-target rule. A reasonable initial
split is:

```text
configuration/
  dependency-maintenance.ts
  deployment.ts
```

Each module exports only arrays of complete `PermitStatementDefinition` values.
`configured-token-issuance-policy.ts` explicitly imports and spreads those
arrays into the compiler. Do not perform runtime filesystem discovery.

Use configuration-local immutable values for repeated subject-token constraints
and target resources. A helper equivalent to the following may be local to the
configuration module:

```ts
type NonEmptyReadonlyArray<Value> = readonly [Value, ...Value[]];

function permitTargets(options: {
  readonly permissions: PermitStatementDefinition["permissions"];
  readonly subjectToken: PermitStatementDefinition["subjectToken"];
  readonly targets: NonEmptyReadonlyArray<GitHubRepositoryResourceConstraintDefinition>;
}): readonly PermitStatementDefinition[] {
  return options.targets.map((resource) => ({
    permissions: options.permissions,
    resource,
    subjectToken: options.subjectToken,
  }));
}
```

Do not export this helper from `token-issuance-policy.ts` without a second real
caller. Its only behavior is ordinary TypeScript expansion and it adds no
authorization capability.

### GitHub Actions workflow authoring

Configuration should make these values visibly reviewable:

- source repository as `owner/repository`;
- workflow path beneath `.github/workflows/`;
- exact branch ref;
- accepted event names;
- every explicit target Repository Resource Constraint; and
- the permission map contributed to each target set.

A configuration-local GitHub Actions helper may derive the full signed
`workflow_ref` from explicit source repository, workflow path, and ref. It must
still produce only the generic OIDC Subject Token Constraint and typed Claim
Predicates accepted by the existing policy module. Do not add a provider-specific
matcher or provider-specific Permit Statement type.

The source repository must never be inferred from a target. Self-targeting
workflows still name the same repository independently in both positions.

### Production migration discipline

Reorganize current production statements without changing their compiled
authorization meaning before adding a new many-target example.

For every current scenario preserve:

- exact OIDC Issuer Identifier;
- selected Claim Names and values;
- accepted event set;
- exact Repository Resource Constraint;
- permission names and levels; and
- configured Provider Registration coverage.

Use the existing configured-policy test oracle to prove parity across all
current positive and negative cases. Source grouping, helper names, and array
order may change; authorization results must not.

If no current production relationship honestly needs a broad target set plus a
subset, do not invent production authority merely to demonstrate the helper.
Cover that shape in focused tests and documentation until a real policy change
requires it.

## Tooling

### Command

Add a repository script with the conceptual interface:

```text
pnpm policy:show-target --target \
  https://api.github.com/repos/chikachow/cyspbot-deploy
```

The script should execute a small TypeScript entrypoint that imports the exact
`configuredTokenIssuancePolicy` object. Prefer the repository's existing Node 24
and TypeScript execution facilities. Add no CLI framework unless native argument
processing is demonstrably inadequate.

Required options:

- `--target <canonical Repository Resource>`;
- `--json` for deterministic machine-readable output; and
- `--help`.

Behavior:

- missing, repeated, malformed, or unknown options exit nonzero;
- malformed or noncanonical target input exits nonzero;
- an unconfigured canonical target prints a clear not-configured result and
  exits nonzero;
- human output groups the complete view beneath the target;
- JSON output serializes the canonical description without additional fields;
  and
- execution performs no network access.

Do not make the tooling a Worker dependency. Verify the production Worker bundle
does not include the CLI entrypoint.

### Human-readable output

For each statement display:

- exact issuer;
- predicates in canonical Claim Name order;
- permissions in canonical permission-name order.

GitHub Actions output will thereby show both:

- `repository == "abc/def"`; and
- `workflow_ref == "abc/def/.github/workflows/foobar.yml@refs/heads/main"`.

Do not print a combined target-wide permission map. Such a map would ignore
subject-token constraints and overstate what any one Verified Subject Token can
obtain.

## Test plan

### Existing semantic baseline

Before changing production configuration, run the focused baseline:

```text
fnm exec --using=24 corepack pnpm exec vitest run \
  test/token-issuance-policy.test.ts \
  test/configured-token-issuance-policy.test.ts \
  test/production-token-exchange-composition.test.ts \
  test/installation-access-token-issuance.test.ts \
  test/oidc-authentication-configuration.test.ts
```

Do not encode a point-in-time test count in the durable ADR or this plan.

### Target Policy View tests

Add interface-level tests covering:

1. `null` for an unconfigured Repository Resource.
2. One statement for one configured target.
3. Several unrelated statements for one target.
4. Statements originating from separate source arrays.
5. One TypeScript expansion producing statements for several targets.
6. A broad expansion plus a narrower subset expansion.
7. Exact duplicate elimination.
8. Preservation of overlapping non-identical statements.
9. Canonical ordering independent of statement order.
10. Canonical ordering independent of Claim Predicate order.
11. Canonical ordering independent of `claim-one-of` value order.
12. Canonical permission property ordering.
13. Deep immutability of every returned object and array.
14. Source-definition mutation after compilation cannot change the view.
15. Invalid opaque policy objects fail through the existing policy guard.

### Authorization non-regression tests

For equivalent policy definitions, prove that adding the description interface
does not change:

- `tokenIssuancePolicyPermits()`;
- `tokenIssuancePolicySupportsTarget()`;
- `tokenIssuancePolicySupportsRequestedPermissions()`;
- OIDC Provider Registration coverage checks;
- exact Requested Permissions sent to GitHub; or
- Boolean policy logging.

For the broad-plus-subset fixture, verify:

| Target    | Applicable contributions             | Allowed request                          |
| --------- | ------------------------------------ | ---------------------------------------- |
| `xyz/one` | `contents:write` and `actions:write` | either permission or both                |
| `xyz/two` | `contents:write`                     | `contents:read` or `contents:write` only |
| other     | none                                 | none                                     |

Also verify permissions never compose across different subject-token
constraints or different Repository Resources.

### Tooling tests

Test the command as a subprocess for:

- a configured target;
- an unconfigured canonical target;
- malformed target input;
- missing and repeated arguments;
- deterministic human output;
- deterministic JSON output;
- explicit source repository visibility; and
- no network dependency.

Prefer a narrow injectable policy value or fixture entrypoint for tests rather
than modifying production configuration to create synthetic authority.

## Implementation sequence

### Phase 1: add canonical description primitives

1. Add description types beside the existing Token Issuance Policy interface.
2. Implement canonical copies of compiled Claim Predicates and permissions.
3. Implement exact semantic duplicate keys and deterministic sorting.
4. Implement `describeTokenIssuancePolicyTarget()` over the existing opaque
   policy.
5. Add all focused interface and immutability tests.

Authorization code must remain unchanged in this phase.

### Phase 2: add the checked-in target command

1. Add the small Node entrypoint.
2. Import the exact production compiled policy.
3. Parse target input using the existing canonical Repository Resource parser.
4. Add human and JSON renderers over `TargetPolicyView`.
5. Add subprocess tests and package scripts.
6. Confirm no CLI code enters the Worker bundle.

### Phase 3: reorganize production authoring

1. Extract current statements into explicit configuration arrays where this
   improves review locality.
2. Introduce configuration-local workflow and target-expansion helpers only
   where they remove genuine repetition.
3. Preserve current production authority exactly.
4. Review the Target Policy View for every configured target before and after
   the refactor; canonical JSON must be identical.
5. Retain the existing configured-policy authorization oracle.

This phase provides the strongest proof that the Target Policy View is a
semantic projection rather than a source-order dump.

### Phase 4: update durable documentation

When implementation is authoritative:

1. Change ADR status to accepted.
2. Update the CEL-free decision's residual-risk note to link to this inspection
   decision rather than describe inspection as future work.
3. Keep Boolean authorization and lack of statement attribution explicit.
4. Update `docs/implementation.md` with the implemented interface, source layout,
   and command.
5. Update `docs/README.md` so accepted decisions and implementation references
   are clearly distinguished.
6. Keep `docs/service-contract.md` unchanged unless externally observable token
   behavior changes; inspection is repository tooling, not a public endpoint.
7. Retain the `Target Policy View` definition in `CONTEXT.md`.

## Verification

Run focused tests during each phase, then the complete repository gate:

```text
fnm exec --using=24 node --run check
```

The full gate covers lockfile consistency, formatting, generated environment
types, lint, TypeScript, unused exports and dependencies, tests, and both Worker
dry-run bundles.

Review the actual dry-run bundle output to confirm target-inspection tooling is
not shipped with either Worker.

## Rollout and rollback

The description interface and CLI are additive and read-only. They can land
before any production configuration refactor.

The production authoring refactor must be a separate, reviewable change whose
before-and-after canonical Target Policy Views are identical. Rollback is a code
revert; checked-in policy has no external migration or runtime state.

Do not combine this work with new production authorization. A future change that
adds targets or permissions should use the completed inspection tooling in its
own review.

## Acceptance criteria

The design is completely implemented only when:

1. The existing CEL-free decision remains authoritative and uncontradicted.
2. `PermitStatementDefinition` remains the only authorization declaration.
3. Every evaluated statement contains one exact Repository Resource Constraint.
4. Ordinary TypeScript can expand common configuration over several explicit
   targets.
5. GitHub Actions source repository and workflow remain explicit.
6. Several unrelated statements for one target remain independently complete
   and compose through the existing evaluator.
7. The Target Policy View is produced from the exact compiled policy used for
   authorization.
8. The view is deterministic under every semantically irrelevant ordering and
   duplicate transformation.
9. The view never reports an unconditional target-wide Effective Permissions
   map.
10. The evaluator remains Boolean and exposes no statement IDs or contributors.
11. Issuance and logging behavior are unchanged.
12. The production policy's before-and-after canonical views are identical for
    an authoring-only refactor.
13. Target tooling performs no network access and is absent from Worker bundles.
14. Durable domain and decision documentation describes the implemented model.
15. The complete Node 24 repository gate passes.
