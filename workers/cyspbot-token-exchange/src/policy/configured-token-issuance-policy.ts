import { githubActionsOidcProviderRegistration } from "../configured-oidc-provider-registrations.ts";
import {
  claimEquals,
  claimOneOf,
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
  type ClaimPredicateDefinition,
  type PermitStatementDefinition,
} from "./token-issuance-policy.ts";

export const configuredTokenIssuancePolicy = compileTokenIssuancePolicy([
  githubActionsPermitStatement({
    eventNames: ["schedule", "workflow_dispatch"],
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    refType: "branch",
    repository: "chikachow/cyspbot",
    resourceOwner: "chikachow",
    resourceRepository: "cyspbot",
    workflowRef: "chikachow/cyspbot/.github/workflows/pnpm-up.yml@refs/heads/main",
  }),
  githubActionsPermitStatement({
    eventNames: ["workflow_run", "workflow_dispatch"],
    permissions: { actions: "write" },
    ref: "refs/heads/main",
    refType: "branch",
    repository: "chikachow/cyspbot",
    resourceOwner: "chikachow",
    resourceRepository: "cyspbot-deploy",
    workflowRef:
      "chikachow/cyspbot/.github/workflows/run-cyspbot-deploy-update.yml@refs/heads/main",
  }),
  githubActionsPermitStatement({
    eventNames: ["workflow_dispatch"],
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    refType: "branch",
    repository: "chikachow/cyspbot-deploy",
    resourceOwner: "chikachow",
    resourceRepository: "cyspbot-deploy",
    workflowRef: "chikachow/cyspbot-deploy/.github/workflows/update-cyspbot.yml@refs/heads/main",
  }),
  githubActionsPermitStatement({
    eventNames: ["schedule", "workflow_dispatch"],
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    refType: "branch",
    repository: "chikachow/cyspbot-app-token-action",
    resourceOwner: "chikachow",
    resourceRepository: "cyspbot-app-token-action",
    workflowRef: "chikachow/cyspbot-app-token-action/.github/workflows/pnpm-up.yml@refs/heads/main",
  }),
  githubActionsPermitStatement({
    eventNames: ["schedule", "workflow_dispatch"],
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    refType: "branch",
    repository: "cysp/graphql-schema-registry",
    resourceOwner: "cysp",
    resourceRepository: "graphql-schema-registry",
    workflowRef: "cysp/graphql-schema-registry/.github/workflows/pnpm-up.yml@refs/heads/main",
  }),
  githubActionsPermitStatement({
    eventNames: ["schedule", "workflow_dispatch"],
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    refType: "branch",
    repository: "cysp/terraform-provider-braze",
    resourceOwner: "cysp",
    resourceRepository: "terraform-provider-braze",
    workflowRef:
      "cysp/terraform-provider-braze/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
  }),
  githubActionsPermitStatement({
    eventNames: ["schedule", "workflow_dispatch"],
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    refType: "branch",
    repository: "cysp/terraform-provider-censusworkspace",
    resourceOwner: "cysp",
    resourceRepository: "terraform-provider-censusworkspace",
    workflowRef:
      "cysp/terraform-provider-censusworkspace/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
  }),
  githubActionsPermitStatement({
    eventNames: ["schedule", "workflow_dispatch"],
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    refType: "branch",
    repository: "cysp/terraform-provider-contentful",
    resourceOwner: "cysp",
    resourceRepository: "terraform-provider-contentful",
    workflowRef:
      "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
  }),
  githubActionsPermitStatement({
    eventNames: ["schedule", "workflow_dispatch"],
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    refType: "branch",
    repository: "cysp/terraform-provider-typesense",
    resourceOwner: "cysp",
    resourceRepository: "terraform-provider-typesense",
    workflowRef:
      "cysp/terraform-provider-typesense/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
  }),
]);

function githubActionsPermitStatement(options: {
  readonly eventNames: readonly string[];
  readonly permissions: PermitStatementDefinition["permissions"];
  readonly ref: string;
  readonly refType: string;
  readonly repository: string;
  readonly resourceOwner: string;
  readonly resourceRepository: string;
  readonly workflowRef: string;
}): PermitStatementDefinition {
  return {
    permissions: options.permissions,
    resource: githubRepositoryResourceConstraint(options.resourceOwner, options.resourceRepository),
    subjectToken: oidcSubjectTokenConstraint(
      githubActionsOidcProviderRegistration.issuer,
      ...githubActionsWorkflowClaimPredicates(options),
    ),
  };
}

function githubActionsWorkflowClaimPredicates(options: {
  readonly eventNames: readonly string[];
  readonly ref: string;
  readonly refType: string;
  readonly repository: string;
  readonly workflowRef: string;
}): readonly ClaimPredicateDefinition[] {
  return Object.freeze([
    claimEquals("repository", options.repository),
    claimOneOf("event_name", options.eventNames),
    claimEquals("ref_type", options.refType),
    claimEquals("ref", options.ref),
    claimEquals("workflow_ref", options.workflowRef),
  ]);
}
