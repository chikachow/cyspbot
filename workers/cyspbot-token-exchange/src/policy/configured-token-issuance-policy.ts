import { githubActionsOidcProviderRegistration } from "../configured-oidc-provider-registrations.ts";
import {
  claimEquals,
  claimOneOf,
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
  type PermitStatementDefinition,
} from "./token-issuance-policy.ts";

type GitHubActionsWorkflowFileName = `${string}.${"yml" | "yaml"}`;
type GitHubRepositoryFullName = `${string}/${string}`;

interface DeploymentRepositoryUpdatePermitStatementsOptions {
  readonly deploymentRepositoryFullName: GitHubRepositoryFullName;
  readonly updateTriggerWorkflowFileName: GitHubActionsWorkflowFileName;
  readonly updateTriggerRepositoryFullName: GitHubRepositoryFullName;
  readonly updateWorkflowFileName: GitHubActionsWorkflowFileName;
}

interface GitHubActionsMainBranchWorkflowPermitStatementOptions {
  readonly eventNames: readonly string[];
  readonly permissions: PermitStatementDefinition["permissions"];
  readonly resourceRepositoryFullName: GitHubRepositoryFullName;
  readonly workflowFileName: GitHubActionsWorkflowFileName;
  readonly workflowRepositoryFullName: GitHubRepositoryFullName;
}

const mainBranchGitRef = "refs/heads/main";
const pullRequestAuthoringPermissions = {
  contents: "write",
  pull_requests: "write",
} as const;

export const configuredTokenIssuancePolicy = compileTokenIssuancePolicy([
  dependencyUpdatePermitStatement("chikachow/cyspbot", "pnpm-up.yml"),
  ...deploymentRepositoryUpdatePermitStatements({
    deploymentRepositoryFullName: "chikachow/cyspbot-deploy",
    updateTriggerWorkflowFileName: "run-cyspbot-deploy-update.yml",
    updateTriggerRepositoryFullName: "chikachow/cyspbot",
    updateWorkflowFileName: "update-cyspbot.yml",
  }),
  dependencyUpdatePermitStatement("chikachow/cloudflare-workload-identity", "pnpm-up.yml"),
  ...deploymentRepositoryUpdatePermitStatements({
    deploymentRepositoryFullName: "chikachow/cloudflare-workload-identity-deploy",
    updateTriggerWorkflowFileName: "run-cloudflare-workload-identity-deploy-update.yml",
    updateTriggerRepositoryFullName: "chikachow/cloudflare-workload-identity",
    updateWorkflowFileName: "update-cloudflare-workload-identity.yml",
  }),
  dependencyUpdatePermitStatement("chikachow/cloudflare-workload-identity-deploy", "pnpm-up.yml"),
  dependencyUpdatePermitStatement("chikachow/cyspbot-app-token-action", "pnpm-up.yml"),
  dependencyUpdatePermitStatement("cysp/graphql-schema-registry", "pnpm-up.yml"),
  dependencyUpdatePermitStatement(
    "cysp/terraform-provider-braze",
    "update-indirect-dependencies.yml",
  ),
  dependencyUpdatePermitStatement(
    "cysp/terraform-provider-censusworkspace",
    "update-indirect-dependencies.yml",
  ),
  dependencyUpdatePermitStatement(
    "cysp/terraform-provider-contentful",
    "update-indirect-dependencies.yml",
  ),
  dependencyUpdatePermitStatement(
    "cysp/terraform-provider-typesense",
    "update-indirect-dependencies.yml",
  ),
]);

function dependencyUpdatePermitStatement(
  repositoryFullName: GitHubRepositoryFullName,
  workflowFileName: GitHubActionsWorkflowFileName,
): PermitStatementDefinition {
  return githubActionsMainBranchWorkflowPermitStatement({
    eventNames: ["schedule", "workflow_dispatch"],
    permissions: pullRequestAuthoringPermissions,
    resourceRepositoryFullName: repositoryFullName,
    workflowFileName,
    workflowRepositoryFullName: repositoryFullName,
  });
}

function deploymentRepositoryUpdatePermitStatements(
  options: DeploymentRepositoryUpdatePermitStatementsOptions,
): readonly PermitStatementDefinition[] {
  return [
    githubActionsMainBranchWorkflowPermitStatement({
      eventNames: ["workflow_run", "workflow_dispatch"],
      permissions: { actions: "write" },
      resourceRepositoryFullName: options.deploymentRepositoryFullName,
      workflowFileName: options.updateTriggerWorkflowFileName,
      workflowRepositoryFullName: options.updateTriggerRepositoryFullName,
    }),
    githubActionsMainBranchWorkflowPermitStatement({
      eventNames: ["workflow_dispatch"],
      permissions: pullRequestAuthoringPermissions,
      resourceRepositoryFullName: options.deploymentRepositoryFullName,
      workflowFileName: options.updateWorkflowFileName,
      workflowRepositoryFullName: options.deploymentRepositoryFullName,
    }),
  ];
}

function githubActionsMainBranchWorkflowPermitStatement(
  options: GitHubActionsMainBranchWorkflowPermitStatementOptions,
): PermitStatementDefinition {
  const [resourceOwner, resourceRepository] = splitGitHubRepositoryFullName(
    options.resourceRepositoryFullName,
  );

  return {
    permissions: options.permissions,
    resource: githubRepositoryResourceConstraint(resourceOwner, resourceRepository),
    subjectToken: oidcSubjectTokenConstraint(
      githubActionsOidcProviderRegistration.issuer,
      claimEquals("repository", options.workflowRepositoryFullName),
      claimOneOf("event_name", options.eventNames),
      claimEquals("ref_type", "branch"),
      claimEquals("ref", mainBranchGitRef),
      claimEquals(
        "workflow_ref",
        `${options.workflowRepositoryFullName}/.github/workflows/${options.workflowFileName}@${mainBranchGitRef}`,
      ),
    ),
  };
}

function splitGitHubRepositoryFullName(
  fullName: GitHubRepositoryFullName,
): readonly [owner: string, repository: string] {
  return fullName.split("/", 2) as [owner: string, repository: string];
}
