# Target-oriented Permit Statement configuration: prior art

Research date: 2026-07-28. Reverified against the cited primary sources and
revised for the implemented CEL-free Token Issuance Policy on 2026-08-02.

## Question

What established authorization models support a checked-in policy where:

- independently complete positive statements compose for one target resource;
- a reviewer can retrieve the complete policy affecting one target;
- hierarchy and inherited defaults are absent unless explicitly modeled; and
- source authoring may reuse one relationship over several explicit targets?

In cyspbot's canonical language, the semantic entry is a **Permit Statement**:

```text
Permit Statement =
  OIDC Subject Token Constraint
  + one exact Repository Resource Constraint
  + non-empty permissions
```

The implemented policy already combines permissions from every applicable
Permit Statement. The remaining design question is how to provide a canonical
target-oriented inspection view without turning a many-target source expression
into a second authorization object.

## Conclusion

The surveyed systems support a narrower proposition: authorization records can
be stored independently and indexed or retrieved from a resource-oriented
perspective. They do not collectively establish that effective authorization
is flat or completely retrievable from one target-local collection:

1. **Cedar** evaluates independent principal-action-resource policies and
   explicitly recommends populated resource scope so policies can be indexed.
2. **Zanzibar and OpenFGA** store direct relationship tuples; both document
   reading every directly stored tuple for one object, while derived
   relationships remain a separate concern.
3. **AWS resource-based policies** and **Google Cloud IAM allow policies** attach
   collections of entries to a resource, but those collections are only part of
   the resource's effective authorization.

None of these systems makes a checked-in source-file path part of authorization
semantics. Their official material discusses policy stores, resource-attached
policies, or relationship APIs rather than prescribing source-file layout. They
therefore do not prove that TypeScript is the right authoring format, but they
do support separating authoring layout from a resource-oriented semantic index.
This is consistent with, but does not compel, cyspbot's design:

- keep exact-resource Permit Statements as the only semantic entries;
- use ordinary TypeScript to generate several complete statements from
  explicit target arrays;
- compile them into the existing opaque Token Issuance Policy; and
- derive a deterministic Target Policy View from that same compiled policy.

## Comparison

| System                        | What the primary source directly establishes                                                           | Limit on the analogy                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Cedar                         | Independent policies scope principal, action, and resource; populated resource scope supports indexing | Also has entities, action entities, `forbid`, and a general evaluator that cyspbot does not need                          |
| OpenFGA                       | Stored user-relation-object tuples can be read by exact object, with any user and relation             | Read returns direct tuples only; the authorization model may imply additional relationships                               |
| AWS resource-based policy     | A resource-attached policy can contain an array of `Statement` values                                  | It is not a complete effective view: AWS can combine identity, resource, boundary, session, and organization policy types |
| Google Cloud IAM allow policy | A resource has one retrievable policy containing role bindings                                         | A binding is complete only with its attached resource; roles hide permissions and ancestor bindings can be inherited      |
| Zanzibar                      | ACLs are relation-tuple collections; Read can select all tuples with an object ID                      | Read excludes userset rewrites; the paper does not establish a checked-in layout or direct-permit statement format        |
| Kubernetes RBAC               | Permissions are additive and role bindings grant referenced roles to subjects                          | Concrete permissions and subjects are separated across roles and bindings, making target review indirect                  |

## Cedar

A Cedar request asks whether a principal may perform an action on a resource in
a context. Each policy independently scopes those values and can add conditions.
Cedar evaluates every relevant policy, permits when at least one `permit`
applies and no `forbid` applies, and denies by default. See Cedar's official
[policy syntax](https://docs.cedarpolicy.com/policies/syntax-policy.html) and
[authorization algorithm](https://docs.cedarpolicy.com/auth/authorization.html).

Cedar authoring guidance recommends populating principal and resource scope so
policies can be indexed efficiently. Its guidance that
[the policy is the relationship](https://docs.cedarpolicy.com/bestpractices/bp-populate-policy-scope.html#the-policy-is-the-relationship)
is close to cyspbot's independently complete Permit Statement model.

The useful parallel is an approximate semantic analogy, not a claim that the
models are equivalent:

| Cedar                | cyspbot                                 |
| -------------------- | --------------------------------------- |
| resource scope       | exact Repository Resource Constraint    |
| principal scope      | OIDC Subject Token Constraint           |
| action scope         | installation permission contribution    |
| independent `permit` | independently complete Permit Statement |
| resource index       | Target Policy View                      |

Cedar's documented authorization input is a policy set, and the authorizer
evaluates each supplied policy. The documented policy syntax and indexing
guidance do not assign semantics to the file containing a policy. That supports
treating target orientation as a retrieval property rather than requiring one
source file per target. It does not, by itself, prescribe how a checked-in
repository should generate or package that policy set.

Cedar policy templates are direct precedent for reusing declaration structure
without making the reusable source construct the evaluated policy. A template
may leave principal or resource as a slot; linking the template to concrete
entities produces a static policy. See Cedar's official
[policy-template documentation](https://docs.cedarpolicy.com/policies/templates.html).
That is analogous to TypeScript expanding reusable data into exact Permit
Statements, although Cedar does not prescribe TypeScript arrays or splats.

Cedar is not recommended as cyspbot's evaluator. The implemented closed policy
already has the required semantics with a smaller interface. Cedar would add an
entity/action model, Cedar policy parsing and evaluation, Worker integration,
and request adaptation while leaving GitHub permission levels, TypeScript
target expansion, OIDC Claim mapping, and target inspection to cyspbot. A Cedar
schema could improve validation, but is not required by Cedar's evaluation
algorithm.

## AWS IAM resource-based policies

AWS resource-based policies are attached to resources, and the IAM grammar lets
one policy contain an array of statements. A resource-based statement includes
a `Principal` and can contain `Action`, `Resource`, and `Condition`. See AWS's
[policy overview](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html),
[identity-based and resource-based policy comparison](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_identity-vs-resource.html)
and [IAM policy grammar](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_grammar.html).

The vocabulary maps approximately:

| AWS statement | cyspbot                        |
| ------------- | ------------------------------ |
| `Principal`   | OIDC Subject Token Constraint  |
| `Action`      | permission contribution        |
| `Resource`    | Repository Resource Constraint |
| `Condition`   | Claim Predicates               |

The resource-local collection is useful precedent for retrieving one group of
entries through a target. It is not precedent for claiming that group is the
target's complete effective policy. AWS evaluates resource- and identity-based
policies together and can also apply organization, session, and boundary
policies; it includes explicit deny and supports wildcard actions and resources.
See AWS's official
[policy-evaluation logic](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html).

## Google Cloud IAM

A Google Cloud IAM allow policy is attached to one resource and contains role
bindings. Each binding associates principals with a role and an optional
condition; the resource comes from the policy attachment rather than from the
binding itself. See
[Understanding allow policies](https://cloud.google.com/iam/docs/allow-policies)
and the [Policy API schema](https://cloud.google.com/iam/docs/reference/rest/v1/Policy).

This is strong precedent for looking up a resource-attached authorization
collection through a target resource:

| Google Cloud IAM                         | cyspbot                       |
| ---------------------------------------- | ----------------------------- |
| resource to which the policy is attached | Repository Resource           |
| binding members                          | OIDC Subject Token Constraint |
| binding role                             | permissions                   |
| binding condition                        | Claim Predicates              |

Three differences make it unsuitable as the complete model:

- an individual binding is not independently resource-complete;
- roles introduce permission indirection; and
- allow policies inherit through the resource hierarchy.

Retrieving the policy attached to a resource does not retrieve inherited
bindings. Google documents a separate Cloud Asset Inventory
[effective IAM policy view](https://cloud.google.com/asset-inventory/docs/view-effective-policies)
for policies set on the resource and inherited from ancestors. Even that view
is specific to Google Cloud's hierarchical model, which cyspbot rejects.

cyspbot should retain the resource-oriented lookup and independent entries, but
not roles, ancestor inheritance, or target-level defaults.

## Zanzibar and OpenFGA

Zanzibar models ACLs as collections of object-user or object-object relation
tuples. Its Read API can select all tuples with a given object ID, optionally
constrained by relation, but Read results do not include userset rewrite rules;
Expand is the separate API for an effective userset. See the
[Zanzibar paper](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/).

OpenFGA expresses a relationship tuple as `user`, `relation`, and `object`, with
an optional condition. Several unrelated tuples may share one object. Its Read
API explicitly supports querying an exact object with any user and relation,
which returns the directly stored tuples for that object. See the official
[OpenFGA concepts](https://openfga.dev/docs/concepts) and
[relationship queries](https://openfga.dev/docs/interacting/relationship-queries),
and
[conditions](https://openfga.dev/docs/modeling/conditions).

OpenFGA is explicit that object-to-object relationships do not automatically
inherit permissions; inheritance must be defined in the authorization model.
See
[Object-to-object relationships](https://openfga.dev/docs/modeling/building-blocks/object-to-object-relationships).

This is strong precedent for retrieving flat, directly stored facts by object
with no relationship implied merely by storing another object-to-object tuple.
It is not precedent for obtaining the complete effective policy from that flat
read: OpenFGA explicitly says Read does not traverse the authorization model.
Derived relationships require that separate model, whereas each cyspbot Permit
Statement carries its permission contribution directly. cyspbot can therefore
make its target view complete precisely because its closed model has no other
source of grants.

## Kubernetes RBAC as a counterexample

Kubernetes documents RBAC permissions as purely additive. RoleBinding and
ClusterRoleBinding objects associate subjects with a separately defined Role or
ClusterRole. See
[Role and ClusterRole](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#role-and-clusterrole)
and
[RoleBinding and ClusterRoleBinding](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#rolebinding-and-clusterrolebinding).

However, it is not target-oriented in the required sense:

- subjects and a role reference live in a binding;
- verbs and resource kinds live in a separately defined role;
- concrete resource names are optional restrictions inside role rules; and
- namespace supplies scope rather than identifying one target object.

Enumerating the RBAC grants affecting a concrete target therefore requires joins
across roles and bindings. Other configured Kubernetes authorizers may add
further authorization sources. That indirection is precisely what a cyspbot
Target Policy View should avoid.

## Related but weaker precedents

- **OPA/Rego** supports additive incremental rule definitions, including across
  modules in the same package, and can construct sets or objects from structured
  input. That demonstrates that source files need not be the semantic unit, but
  its domain-agnostic language does not establish a conventional authorization
  statement shape or target orientation. See the
  [Rego policy language](https://www.openpolicyagent.org/docs/policy-language).
- **OAuth Rich Authorization Requests** defines an `authorization_details`
  array whose type-specific objects may use common fields such as `actions` and
  `locations`, but describes client-requested authorization rather than
  server-side issuance-policy authoring. See
  [RFC 9396](https://www.rfc-editor.org/rfc/rfc9396.html).

Neither provides a reason to replace cyspbot's implemented closed Permit
Statement language.

## Recommendation for cyspbot

The precedent supports resource-oriented inspection over cyspbot's existing
closed relation of Permit Statements. The following details are cyspbot design
choices justified by that closed model, not requirements imposed by the cited
systems:

1. Preserve one exact Repository Resource Constraint per evaluated statement.
2. Let ordinary TypeScript expand common subject and permission data over
   explicit target arrays.
3. Compile only the resulting complete Permit Statements.
4. Derive a canonical Target Policy View from the same opaque compiled policy
   used for authorization.
5. Show every distinct normalized statement for the requested target.
6. Do not compute an unconditional permission ceiling without a Verified
   Subject Token.
7. Do not add target defaults, roles, inheritance, wildcard membership, or a
   second policy evaluator.

The research does not settle statement identity, provenance, or deduplication.
Cedar supports policy identifiers and annotations, and AWS supports an optional
`Sid`; whether cyspbot needs a stable identifier should be decided from its own
review, diagnostics, and deployment-provenance requirements.

This design is best described as **target-oriented inspection of a flat Permit
Statement policy**. The prior art supports the narrower retrieval pattern, but
does not prescribe cyspbot's TypeScript source layout, normalized target view,
deduplication behavior, or statement identity.
