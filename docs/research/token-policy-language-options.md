# Token Policy Language Options

This note compares policy language options for a redesigned token exchange authorization module.

The target service remains an OAuth 2.0 Token Exchange authorization server / STS that accepts a verified `subject_token` and issues only GitHub App installation access tokens. The desired policy shape is issuer-agnostic: rules should evaluate over a verified JWT/OIDC claim set and token exchange request fields, and should not require issuer-specific principal fields unless a policy condition names them.

## Evaluation Criteria

- Embeddable in the Cloudflare Worker request path.
- Deterministic and safe to run on caller-influenced claims.
- Good at predicates over JSON-like JWT claims and token exchange request fields.
- Supports checked-in policy with reviewable syntax.
- Supports validation or testing of policy before deploy.
- Avoids a remote policy decision point for the hot path.

## Spec Constraints

RFC 8693 leaves validation details for a `subject_token` to the token type, token contents, and deployment policy. This supports keeping issuer trust and token verification in code while moving authorization decisions into policy. Source: <https://www.rfc-editor.org/rfc/rfc8693.html>

JWT claim requirements are application-specific. RFC 7519 says required claims are context dependent and applications define which claims they use. Source: <https://www.rfc-editor.org/rfc/rfc7519.html>

`resource` and `scope` are requested-token fields, not subject identity. RFC 8707 defines `resource` as the target protected resource, while OAuth scope describes requested access. Source: <https://www.rfc-editor.org/rfc/rfc8707.html>

Audience remains a verifier/security invariant, not an ordinary optional policy condition. OIDC requires the client to be listed in `aud`, and bearer-token guidance uses audience restriction to mitigate token redirect. Sources: <https://openid.net/specs/openid-connect-core-1_0.html>, <https://www.rfc-editor.org/rfc/rfc6750.html>

## Options

### CEL

Common Expression Language is the best semantic fit for claim-condition policy. CEL is explicitly designed as a fast, portable, safe expression language embedded into applications. The official overview calls out authorization rules for API requests and HTTP request evaluation against a security policy as intended use cases. CEL is non-Turing-complete and only accesses host-provided data. Sources: <https://cel.dev/>, <https://github.com/cel-expr/cel-spec>

There is a TypeScript/ECMAScript implementation, `@bufbuild/cel`, from Buf. It is currently beta, but it is native to this repo's runtime language and avoids a Wasm build artifact. Source: <https://github.com/bufbuild/cel-es>

Fit:

- Strong match for `claims.repository == "..." && request.resource == "..."`.
- Easy to embed behind a deep policy module.
- Small policy surface: one expression per rule or named condition block.
- Good default when the policy is mostly ABAC over a single verified assertion.

Risk:

- The ECMAScript implementation is beta.
- CEL itself is an expression language, not a full authorization model. The service must still own rule structure, default deny, effect handling, and diagnostics.

Recommended shape:

```ts
{
  effect: "allow",
  issue: {
    githubInstallationToken: {
      permissions: { contents: "write", pull_requests: "write" },
      resource: "https://api.github.com/repos/chikachow/cyspbot-deploy",
    },
  },
  when:
    "claims.iss == 'https://token.actions.githubusercontent.com' && " +
    "claims.repository == 'chikachow/cyspbot-deploy' && " +
    "claims.event_name == 'workflow_dispatch' && " +
    "claims.ref == 'refs/heads/main'",
}
```

### Cedar

Cedar is a full authorization policy language with `permit` / `forbid`, default deny, forbid-overrides-permit, diagnostics, schemas, entities, actions, resources, and context. The official docs describe policies as separate from application code and define the authorization request in terms of principal, action, resource, and context. Sources: <https://docs.cedarpolicy.com/>, <https://docs.cedarpolicy.com/auth/authorization.html>, <https://docs.cedarpolicy.com/schema/schema.html>

Fit:

- Strong authorization semantics and auditability.
- Schema validation is a real advantage for policy review.
- Natural if the service evolves toward multiple issued-token actions or resource types.

Risk:

- Cedar wants an entity/action/resource model. This service is currently narrower: one action, one issued token type, one request-local claim set.
- In a Worker, Cedar likely means Wasm or a managed service. A managed service is the wrong hot-path shape here; Wasm is viable but adds build and runtime surface.
- Mapping arbitrary issuer claims into Cedar entities/context is extra modeling work.

Recommended only if we want `forbid` policies, policy templates, schema validation, and a durable authorization model that outgrows simple claim predicates.

### OPA / Rego

Open Policy Agent's Rego is very expressive over JSON input and has strong policy-as-code tooling. OPA can compile Rego policies to WebAssembly for JavaScript evaluation, but the Wasm path has an ABI, entrypoints, result handling, unsupported built-ins, and host callback considerations. Sources: <https://www.openpolicyagent.org/docs/policy-language>, <https://www.openpolicyagent.org/docs/wasm>

Fit:

- Excellent if policy decisions become complex, multi-document, or shared with infrastructure policy.
- Mature testing and tooling ecosystem.

Risk:

- Rego is more language than this service currently needs.
- Wasm compilation adds generated artifacts and deployment complexity.
- Some built-ins are unsupported in Wasm or require host implementations.

Recommendation: do not start here for this service. Revisit if policy grows beyond request-local JWT claim predicates.

### OpenFGA / Zanzibar-Style ReBAC

OpenFGA models users, relations, and objects. Its modeling guide starts from statements like "user can perform action on object if conditions" and relationship tuples. Source: <https://openfga.dev/docs/modeling/getting-started>

Fit:

- Good for graph authorization: repository membership, org relationships, delegated access, sharing, hierarchy.
- Useful if cyspbot later authorizes based on mutable relationship data outside the token.

Risk:

- Poor fit for deterministic, checked-in, request-local token exchange policy.
- Usually a remote decision service, which is unnecessary for this hot path.

Recommendation: not appropriate for this redesign.

### AWS IAM-Style JSON Policy

AWS IAM JSON policies use statements with `Effect`, `Action`, `Resource`, optional `Principal`, and optional `Condition`. AWS evaluates conditions only when they match, applies OR across statements, and explicit deny overrides allow. Source: <https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html>

Fit:

- Familiar, reviewable JSON shape.
- `Condition` maps well to claim/request predicates.

Risk:

- There is no canonical embeddable IAM evaluator for arbitrary custom applications.
- Reimplementing IAM condition semantics would create a large compatibility and security surface.

Recommendation: borrow structural ideas, not semantics. A local policy shape can use `effect`, `action`, `resource`, and `condition`, but should not claim IAM compatibility.

### Casbin

Casbin's Node implementation supports ACL, RBAC, ABAC, and browser use. It exposes an enforcer that evaluates subject, object, and action tuples against model and policy files. Source: <https://github.com/apache/casbin-node-casbin>

Fit:

- Native JS library.
- Mature enough for common access-control models.

Risk:

- The model/policy split is not a natural fit for arbitrary JWT claim predicates.
- Static schema/audit story is weaker than Cedar and less direct than CEL.

Recommendation: viable but not preferred.

### Oso / Polar

Oso Cloud uses Polar, a declarative logic language, and evaluates authorization through service APIs or SDKs. Sources: <https://www.osohq.com/docs>, <https://www.osohq.com/docs/reference/polar/introduction>

Fit:

- Expressive for application authorization with facts and relationships.

Risk:

- Cloud/service orientation is the wrong default for a local token-exchange hot path.
- More logic-programming power than needed for request-local claim checks.

Recommendation: not appropriate for this service.

### XACML / ALFA

XACML 3.0 is a standardized access-control policy language from OASIS. Source: <https://www.oasis-open.org/standard/xacmlv3-0/>

Fit:

- Complete ABAC vocabulary and standard policy decision point concepts.

Risk:

- Heavy XML/PDP heritage and poor TypeScript/Workers fit.
- Too much ceremony for checked-in token exchange rules.

Recommendation: reject.

### JSONLogic / json-rules-engine

These are lightweight JavaScript-native rule formats, but they lack CEL/Cedar's authorization-specific semantics, source-backed language specification, and validation story.

Recommendation: reject unless dependency footprint is the only criterion.

## Recommendation

Use CEL inside a checked-in typed policy schema.

The deep module should own:

- default deny;
- allow/deny effect semantics;
- rule validation;
- CEL environment construction;
- CEL expression compilation;
- claim/request input normalization;
- diagnostics and deny reasons;
- GitHub installation token issue shape validation.

The CEL expression should only answer whether a rule's conditions match. It should not decide what token to issue.

Interface:

```ts
evaluateTokenExchangePolicy({
  subject: {
    issuer: string;
    subjectTokenType: "id_token" | "jwt";
    claims: Record<string, unknown>;
    resolvedKeyId: string | null;
  },
  request: {
    resource: string;
    permissions: Record<string, string>;
    scope: string;
  },
  rules: TokenExchangePolicyRule[];
}): TokenPolicyDecision;
```

Policy:

```ts
{
  id: "github-cyspbot-deploy-update",
  effect: "allow",
  subject: {
    issuer: "https://token.actions.githubusercontent.com",
  },
  issue: {
    githubInstallationToken: {
      resource: "https://api.github.com/repos/chikachow/cyspbot-deploy",
      permissions: {
        contents: "write",
        pull_requests: "write",
      },
    },
  },
  when:
    "claims[\"repository\"] == 'chikachow/cyspbot-deploy' && " +
    "claims[\"event_name\"] == 'workflow_dispatch' && " +
    "claims[\"ref\"] == 'refs/heads/main' && " +
    "claims[\"workflow_ref\"] == 'chikachow/cyspbot-deploy/.github/workflows/update-cyspbot.yml@refs/heads/main'",
}
```

This preserves the main design goal: the verified token can have any issuer-specific shape, and the service only requires the claims that a matching checked-in policy condition actually reads.

## Open Design Questions

- Should missing claim references evaluate as false, or should they produce a policy error that is skipped and logged?
- Should `forbid` be supported now, or should policy remain allow-list only?
- Should all rules require explicit `subject.issuer`, or can issuer checks live in trusted issuer config plus optional policy predicates? Recommendation: make the expected issuer typed rule data so issuer isolation is enforced by the policy engine, while CEL remains responsible for issuer-specific claim predicates.
- Should `aud == "cyspbot"` remain a verifier invariant? Recommendation: yes.
- Should Google `azp == sub` remain a verifier invariant? Recommendation: yes for the current trusted issuer profile because it explicitly means "Google service-account ID token"; CEL can still express additional service-account identity requirements.
