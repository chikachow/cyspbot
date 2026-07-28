---
status: proposed
date: 2026-08-02
---

# Target-oriented Token Issuance Policy

cyspbot will retain its accepted CEL-free Token Issuance Policy and add a
canonical **Target Policy View** over the same opaque compiled policy. Checked-in
TypeScript may generate complete Permit Statements for several explicit
Repository Resources, but a generated statement still contains exactly one
OIDC Subject Token Constraint, one exact Repository Resource Constraint, and
one non-empty permission map. This makes a Repository Resource the primary
inspection and review orientation without creating hierarchy, inheritance, a
second policy language, or evaluation-time statement attribution.

## Status and relationship to existing decisions

This decision is proposed and not implemented.

It extends, and does not replace, the accepted
[CEL-free Token Issuance Policy](../decisions/cel-free-token-issuance-policy.md).
That upstream decision and implementation already establish that:

- Permit Statements are the only authorization declarations;
- every Permit Statement is independently complete and constrains one exact
  Repository Resource;
- every applicable statement contributes permissions pointwise using
  `omitted < read < write < admin`;
- several unrelated statements can jointly cover one request;
- statement order, grouping, overlap, and exact duplicates have no
  authorization meaning;
- evaluation is total and Boolean;
- the evaluator exposes no statement identifiers, contributor list, or denial
  reasons; and
- ordinary TypeScript arrays, spreads, `map`, and `flatMap` provide authoring
  reuse.

Those are constraints on this proposal, not work to reimplement. In
particular, this decision does not reintroduce CEL, provider-specific matchers,
grant clauses, whole-request matching, rule identifiers, contributor logging,
or a new permission algebra.

The detailed implementation sequence is maintained separately in the
[target-oriented Token Issuance Policy implementation plan](../plans/target-oriented-token-issuance-policy.md).

## Context

The implemented policy is semantically composable but is currently authored as
a flat array of exact-resource Permit Statements. That is sufficient for
authorization but does not make this review question easy to answer:

> What complete checked-in policy can affect Installation Access Token Issuance
> for this Repository Resource?

The question becomes more important when ordinary TypeScript reuse is used in
both directions required by policy authors:

- one source workflow and permission map may apply to several explicit target
  repositories; and
- another statement for the same workflow may add a permission only for a
  subset of those repositories.

For example, the intended configuration must be able to express:

```text
the workflow .github/workflows/foobar.yml
in source repository abc/def
may request contents:write
for target repositories xyz/one and xyz/two

and the same workflow may additionally request actions:write
for target repository xyz/one
```

For `xyz/one`, both resulting statements are visible and their permissions can
compose. For `xyz/two`, only the contents statement exists. The source
repository remains explicit; it is never inferred from a target Repository
Resource or from an Installation Access Token Request.

No hand-authored source file can always be the complete target policy while
both forms of reuse remain possible. Requiring one authoritative file per
target would duplicate broad declarations. Treating a multi-target container as
an authorization object would instead create a second semantic layer above
Permit Statements. The complete target-oriented answer must therefore be a
projection of compiled policy.

## Decision

### Preserve Permit Statements as the semantic unit

The accepted Permit Statement model remains unchanged. Each statement contains:

- one issuer-qualified OIDC Subject Token Constraint;
- one exact Repository Resource Constraint; and
- one non-empty permission map.

The terms `grant`, `rule`, `clause`, `principal`, and `action` are not introduced
as aliases. In particular, a TypeScript expression that maps one subject-token
constraint and permission map over several Repository Resource Constraints is
not a new domain object. Its evaluated result is only an array of complete
Permit Statement definitions.

This preserves the accepted invariants:

- no field is inherited from a parent configuration object;
- no statement depends on adjacency, source-file location, or array order;
- no statement can add a target to another statement;
- permissions compose only among statements whose complete subject-token and
  exact resource constraints apply; and
- splitting or combining equivalent definitions does not change authority.

### Use ordinary TypeScript for explicit many-target reuse

Checked-in policy may define reusable immutable values and configuration-local
functions that return `readonly PermitStatementDefinition[]`. A helper may
expand a non-empty array of explicit Repository Resource Constraints, but it
must return complete statements accepted by the existing
`compileTokenIssuancePolicy()` interface.

Representative authoring:

```ts
import { githubActionsOidcProviderRegistration } from "../configured-oidc-provider-registrations.ts";
import {
  claimEquals,
  claimOneOf,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
  type GitHubRepositoryResourceConstraintDefinition,
  type PermitStatementDefinition,
} from "./token-issuance-policy.ts";

type NonEmptyReadonlyArray<Value> = readonly [Value, ...Value[]];

const foobarWorkflow = oidcSubjectTokenConstraint(
  githubActionsOidcProviderRegistration.issuer,
  claimEquals("repository", "abc/def"),
  claimOneOf("event_name", ["workflow_dispatch"]),
  claimEquals("ref_type", "branch"),
  claimEquals("ref", "refs/heads/main"),
  claimEquals("workflow_ref", "abc/def/.github/workflows/foobar.yml@refs/heads/main"),
);

const xyzOne = githubRepositoryResourceConstraint("xyz", "one");
const xyzTwo = githubRepositoryResourceConstraint("xyz", "two");

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

export const foobarPermitStatements = [
  ...permitTargets({
    permissions: { contents: "write" },
    subjectToken: foobarWorkflow,
    targets: [xyzOne, xyzTwo],
  }),
  ...permitTargets({
    permissions: { actions: "write" },
    subjectToken: foobarWorkflow,
    targets: [xyzOne],
  }),
] satisfies readonly PermitStatementDefinition[];
```

The example deliberately names the source repository in the signed
`repository` Claim predicate and again as part of the exact `workflow_ref`.
Neither value is derived from `xyzOne` or `xyzTwo`.

The helper belongs with checked-in configuration unless a second real caller
establishes a reusable seam. It is not added to the Token Issuance Policy
interface merely to shorten one configuration file.

Target collections must contain explicit canonical Repository Resource
Constraints after TypeScript evaluation. This proposal adds no wildcard, glob,
owner-wide selector, target group with mutable membership, runtime discovery,
or target inference.

### Add a Target Policy View to the existing deep module

The Token Issuance Policy module will expose a read-only operation equivalent
to:

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

The exact exported names may change during implementation, but the interface
semantics are part of this decision:

- it accepts the same opaque compiled Token Issuance Policy used by
  authorization;
- it accepts one already normalized Repository Resource;
- it returns `null` when no statement constrains that resource;
- it returns every distinct normalized Permit Statement that constrains that
  resource, regardless of whether any particular Subject Token would match;
- it exposes immutable data descriptions, not executable predicates or the
  private compiled representation; and
- it performs no network access and has no dependency on runtime token claims.

This operation deepens the existing module: callers learn one target-oriented
query while the module owns normalization, duplicate elimination, stable
ordering, and its private representation. A separate index, repository, port,
or Adapter is not introduced unless an implementation later demonstrates a
second representation or external data source.

### Make the view canonical and semantic

A Target Policy View describes effective checked-in policy, not source
provenance. It therefore normalizes away distinctions that the accepted
authorization model says are meaningless:

- exact duplicate statements appear once;
- Claim Predicates are ordered canonically by Claim Name;
- finite membership values are ordered canonically;
- permission names are ordered canonically in serialized output; and
- statement descriptions are ordered by their canonical content.

The view must be invariant under:

- source-file order;
- array-spread order;
- target-array order;
- Permit Statement order;
- Claim Predicate order;
- finite membership-value order; and
- insertion of an exact duplicate statement.

The view does not simplify overlapping but non-identical subject constraints or
permission maps. Determining logical implication between arbitrary collections
of typed predicates would introduce overlap analysis that the accepted policy
decision rejects. Reviewers see each distinct normalized statement and reason
about their combined authority for the target.

The view must not display one unconditional Effective Permissions map. Effective
Permissions depend on which OIDC Subject Token Constraint matches a particular
Verified Subject Token. Combining permissions across all statements for a
target would overstate authority.

### Keep authorization Boolean and unattributed

Target inspection does not change evaluation. `tokenIssuancePolicyPermits()`
continues to return only a Boolean, issuance logging continues to record only
the Boolean policy outcome, and GitHub continues to receive the exact Requested
Permissions.

Stable statement identifiers and evaluation-time contributor lists are not
added. Under the accepted algebra, splitting one statement into two, merging
two equivalent statements, or adding a duplicate cannot change authority. A
contributor list would nevertheless change under those representation-only
edits and would therefore make logs depend on configuration grouping that the
authorization model deliberately treats as non-semantic.

The Target Policy View meets the present audit need by showing the complete
policy capable of affecting one target. If future operations require linking a
production decision to an exact deployed source revision, that should use a
policy-version or deployment-manifest decision. It should not retrofit identity
onto individual Permit Statements.

### Provide deterministic checked-in-policy tooling

Repository tooling will load the exact configured Token Issuance Policy and
render its Target Policy View. The initial interface should support:

```text
pnpm policy:show-target --target \
  https://api.github.com/repos/xyz/one
```

Human-readable output is the primary review surface. Deterministic JSON output
is required for tests and automation. The tool must:

- normalize target input through the existing Repository Resource constructor;
- reject malformed or noncanonical input;
- use the same compiled policy object as production configuration;
- show the exact issuer, Claim Predicates, and permissions of every statement;
- make the GitHub source repository and `workflow_ref` visible when selected;
- perform no network access; and
- exit nonzero for invalid input or invalid checked-in configuration.

No generated Target Policy View is checked into Git initially. A generated file
would be a second artifact that could become stale. If code review later needs
checked-in projections, a separate decision must define deterministic
generation and CI drift enforcement.

### Treat target orientation as inspection ownership

Permit Statements remain the authoring and authorization unit. Repository
Resource is the primary inspection, review, and support orientation.

This distinction is intentional. It reconciles all required forms of
composition:

- one source file may define statements for several targets;
- several source files may define statements for one target;
- one TypeScript expression may expand common subject and permission data over
  several explicit targets; and
- the Target Policy View remains the complete authoritative answer for exactly
  one target.

Raw source search is useful but not authoritative once TypeScript reuse is
allowed. Policy reviews that change target membership or permissions must
inspect the before-and-after Target Policy View for every affected Repository
Resource.

## Consequences

### Positive

- The already-implemented authorization semantics remain untouched.
- Unrelated statements continue to compose for one target without hierarchy or
  shared defaults.
- Broad and subset target sets can reuse TypeScript without widening the policy
  language.
- The source repository of a GitHub Actions workflow remains explicit.
- Reviewers receive a deterministic complete policy view for one target from
  the exact compiled policy used in production.
- The Token Issuance Policy module remains opaque and gains leverage without
  exposing its implementation.
- Inspection output is stable under semantically irrelevant source edits.

### Negative

- The authored source layout alone is not the complete target-oriented view.
- Reviewers must run target inspection for changed targets when configuration
  uses cross-target reuse.
- Canonical inspection cannot explain source-file provenance or identify which
  expression generated a statement.
- Overlapping non-identical Subject Token Constraints remain visible but are not
  simplified or analyzed for implication.
- A future requirement for deployment-version provenance would require a
  separate decision.

## Considered alternatives

### Replace Permit Statements with multi-target grant clauses

Rejected because upstream already implements the required additive semantics
with independently complete exact-resource Permit Statements. A second semantic
authoring object would duplicate compilation and validation concepts and
conflict with the accepted domain language.

### One authoritative source file per target

Rejected because one workflow and permission map may intentionally apply to
several targets. Requiring duplication would make broad policy changes harder to
review and easier to drift.

### Target-level defaults or inherited fields

Rejected because a statement must remain independently complete. Defaults would
make authority depend on nesting or file placement and would undermine ordinary
TypeScript expansion into a flat policy.

### Stable statement identifiers and contributor logging

Rejected for this design because identifiers would make representation grouping
observable even though splitting, merging, order, and duplicates have no
authorization meaning. Target inspection addresses the current audit question
without changing evaluation results or logs.

### Generated checked-in target files

Rejected initially because they duplicate the authoritative compiled policy and
can become stale. Deterministic on-demand inspection is sufficient for the
current checked-in deployment model.

### Cedar as policy language or evaluator

Rejected for the same reasons recorded by the accepted CEL-free decision. The
service authorizes one operation over one resource type using a small closed
predicate language and pointwise permission coverage. Cedar would not remove
TypeScript target expansion, GitHub permission-level handling, Subject Token
Claim adaptation, target inspection, or Cloudflare integration. The existing
purpose-built evaluator already implements the needed semantics with a smaller
interface.

Cedar should be reconsidered only if cyspbot acquires several authorization
operations or resource domains, a shared entity model, explicit deny semantics,
or a separately managed policy platform.

## References

- [cyspbot domain glossary](../../CONTEXT.md)
- [CEL-free Token Issuance Policy decision](../decisions/cel-free-token-issuance-policy.md)
- [OIDC ID Token authentication decision](../decisions/oidc-id-token-authentication.md)
- [Implementation reference](../implementation.md)
- [Service contract](../service-contract.md)
- [Implementation plan](../plans/target-oriented-token-issuance-policy.md)
- [Target-oriented authorization prior art](../research/target-oriented-permit-statement-prior-art.md)
