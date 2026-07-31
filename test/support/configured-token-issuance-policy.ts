import { githubActionsOidcProviderRegistration } from "@cyspbot/oidc-provider-github-actions";
import {
  createGitHubRepositoryResource,
  installationAccessTokenPermissionLevelCovers,
  type GitHubInstallationPermissions,
  type InstallationAccessTokenRequest,
} from "@cyspbot/token-exchange/installation-access-token-request";
import type { VerifiedSubjectToken } from "@cyspbot/token-exchange/authentication";
import { createVerifiedSubjectToken } from "./oidc.ts";

export interface ConfiguredTokenIssuancePolicyScenario {
  readonly events: readonly string[];
  readonly name: string;
  readonly permissions: GitHubInstallationPermissions;
  readonly ref: string;
  readonly repository: string;
  readonly resourceOwner: string;
  readonly resourceRepository: string;
  readonly workflowRef: string;
}

export const configuredTokenIssuancePolicyScenarios: readonly ConfiguredTokenIssuancePolicyScenario[] =
  [
    {
      events: ["schedule", "workflow_dispatch"],
      name: "cyspbot pnpm-up",
      permissions: { contents: "write", pull_requests: "write" },
      ref: "refs/heads/main",
      repository: "chikachow/cyspbot",
      resourceOwner: "chikachow",
      resourceRepository: "cyspbot",
      workflowRef: "chikachow/cyspbot/.github/workflows/pnpm-up.yml@refs/heads/main",
    },
    {
      events: ["workflow_run", "workflow_dispatch"],
      name: "cyspbot deployment update trigger",
      permissions: { actions: "write" },
      ref: "refs/heads/main",
      repository: "chikachow/cyspbot",
      resourceOwner: "chikachow",
      resourceRepository: "cyspbot-deploy",
      workflowRef:
        "chikachow/cyspbot/.github/workflows/run-cyspbot-deploy-update.yml@refs/heads/main",
    },
    {
      events: ["workflow_dispatch"],
      name: "cyspbot-deploy update",
      permissions: { contents: "write", pull_requests: "write" },
      ref: "refs/heads/main",
      repository: "chikachow/cyspbot-deploy",
      resourceOwner: "chikachow",
      resourceRepository: "cyspbot-deploy",
      workflowRef: "chikachow/cyspbot-deploy/.github/workflows/update-cyspbot.yml@refs/heads/main",
    },
    {
      events: ["schedule", "workflow_dispatch"],
      name: "app-token-action pnpm-up",
      permissions: { contents: "write", pull_requests: "write" },
      ref: "refs/heads/main",
      repository: "chikachow/cyspbot-app-token-action",
      resourceOwner: "chikachow",
      resourceRepository: "cyspbot-app-token-action",
      workflowRef:
        "chikachow/cyspbot-app-token-action/.github/workflows/pnpm-up.yml@refs/heads/main",
    },
    {
      events: ["schedule", "workflow_dispatch"],
      name: "graphql-schema-registry pnpm-up",
      permissions: { contents: "write", pull_requests: "write" },
      ref: "refs/heads/main",
      repository: "cysp/graphql-schema-registry",
      resourceOwner: "cysp",
      resourceRepository: "graphql-schema-registry",
      workflowRef: "cysp/graphql-schema-registry/.github/workflows/pnpm-up.yml@refs/heads/main",
    },
    {
      events: ["schedule", "workflow_dispatch"],
      name: "terraform-provider-braze dependency update",
      permissions: { contents: "write", pull_requests: "write" },
      ref: "refs/heads/main",
      repository: "cysp/terraform-provider-braze",
      resourceOwner: "cysp",
      resourceRepository: "terraform-provider-braze",
      workflowRef:
        "cysp/terraform-provider-braze/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
    },
    {
      events: ["schedule", "workflow_dispatch"],
      name: "terraform-provider-censusworkspace dependency update",
      permissions: { contents: "write", pull_requests: "write" },
      ref: "refs/heads/main",
      repository: "cysp/terraform-provider-censusworkspace",
      resourceOwner: "cysp",
      resourceRepository: "terraform-provider-censusworkspace",
      workflowRef:
        "cysp/terraform-provider-censusworkspace/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
    },
    {
      events: ["schedule", "workflow_dispatch"],
      name: "terraform-provider-contentful dependency update",
      permissions: { contents: "write", pull_requests: "write" },
      ref: "refs/heads/main",
      repository: "cysp/terraform-provider-contentful",
      resourceOwner: "cysp",
      resourceRepository: "terraform-provider-contentful",
      workflowRef:
        "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
    },
    {
      events: ["schedule", "workflow_dispatch"],
      name: "terraform-provider-typesense dependency update",
      permissions: { contents: "write", pull_requests: "write" },
      ref: "refs/heads/main",
      repository: "cysp/terraform-provider-typesense",
      resourceOwner: "cysp",
      resourceRepository: "terraform-provider-typesense",
      workflowRef:
        "cysp/terraform-provider-typesense/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
    },
  ];

const permissionLevels = [undefined, "read", "write"] as const;

export const allNonEmptyGitHubInstallationPermissionMaps = permissionLevels
  .flatMap((actions) =>
    permissionLevels.flatMap((contents) =>
      permissionLevels.map((pullRequests) => ({
        ...(actions === undefined ? {} : { actions }),
        ...(contents === undefined ? {} : { contents }),
        ...(pullRequests === undefined ? {} : { pull_requests: pullRequests }),
      })),
    ),
  )
  .filter((permissions) => Object.keys(permissions).length > 0);

export function configuredSubjectToken(
  scenario: ConfiguredTokenIssuancePolicyScenario,
  claims: Record<string, unknown> = {},
  options: { readonly issuer?: string } = {},
): VerifiedSubjectToken {
  return createVerifiedSubjectToken(
    {
      event_name: scenario.events[0],
      ref: scenario.ref,
      ref_type: "branch",
      repository: scenario.repository,
      repository_id: "123456789",
      repository_owner_id: "555555",
      sub: `repo:${scenario.repository}:ref:${scenario.ref}`,
      workflow_ref: scenario.workflowRef,
      ...claims,
    },
    { issuer: options.issuer ?? githubActionsOidcProviderRegistration.issuer },
  );
}

export function configuredRequest(
  scenario: ConfiguredTokenIssuancePolicyScenario,
  permissions: GitHubInstallationPermissions,
  resourceOwner = scenario.resourceOwner,
  resourceRepository = scenario.resourceRepository,
): InstallationAccessTokenRequest {
  return {
    permissions,
    resource: createGitHubRepositoryResource({
      owner: resourceOwner,
      repository: resourceRepository,
    }),
    scope: "configured-policy-test",
  };
}

export function configuredPermissionsCover(
  configured: GitHubInstallationPermissions,
  requested: GitHubInstallationPermissions,
): boolean {
  return (Object.keys(requested) as (keyof GitHubInstallationPermissions)[]).every((name) => {
    const requestedLevel = requested[name];

    return (
      requestedLevel !== undefined &&
      installationAccessTokenPermissionLevelCovers(configured[name], requestedLevel)
    );
  });
}
