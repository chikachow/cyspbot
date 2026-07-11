import { githubActionsInstallationTokenRule } from "./github-actions-token-policy-rule.ts";
import { validateTokenPolicyRules, type TokenPolicyRule } from "./token-policy.ts";

export const tokenPolicyRules = validateTokenPolicyRules([
  githubActionsInstallationTokenRule({
    eventNames: ["schedule", "workflow_dispatch"],
    id: "github-actions-cyspbot-pnpm-up",
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    ref: "refs/heads/main",
    repository: "chikachow/cyspbot",
    resource: "https://api.github.com/repos/chikachow/cyspbot",
    workflowRef: "chikachow/cyspbot/.github/workflows/pnpm-up.yml@refs/heads/main",
  }),
  githubActionsInstallationTokenRule({
    eventNames: ["workflow_run", "workflow_dispatch"],
    id: "github-actions-cyspbot-run-deploy-update",
    permissions: {
      actions: "write",
    },
    ref: "refs/heads/main",
    repository: "chikachow/cyspbot",
    resource: "https://api.github.com/repos/chikachow/cyspbot-deploy",
    workflowRef:
      "chikachow/cyspbot/.github/workflows/run-cyspbot-deploy-update.yml@refs/heads/main",
  }),
  githubActionsInstallationTokenRule({
    eventNames: ["workflow_dispatch"],
    id: "github-actions-cyspbot-deploy-update",
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    ref: "refs/heads/main",
    repository: "chikachow/cyspbot-deploy",
    resource: "https://api.github.com/repos/chikachow/cyspbot-deploy",
    workflowRef: "chikachow/cyspbot-deploy/.github/workflows/update-cyspbot.yml@refs/heads/main",
  }),
  githubActionsInstallationTokenRule({
    eventNames: ["schedule", "workflow_dispatch"],
    id: "github-actions-app-token-action-pnpm-up",
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    ref: "refs/heads/main",
    repository: "chikachow/cyspbot-app-token-action",
    resource: "https://api.github.com/repos/chikachow/cyspbot-app-token-action",
    workflowRef: "chikachow/cyspbot-app-token-action/.github/workflows/pnpm-up.yml@refs/heads/main",
  }),
  githubActionsInstallationTokenRule({
    eventNames: ["schedule", "workflow_dispatch"],
    id: "github-actions-graphql-schema-registry-pnpm-up",
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    ref: "refs/heads/main",
    repository: "cysp/graphql-schema-registry",
    resource: "https://api.github.com/repos/cysp/graphql-schema-registry",
    workflowRef: "cysp/graphql-schema-registry/.github/workflows/pnpm-up.yml@refs/heads/main",
  }),
  githubActionsInstallationTokenRule({
    eventNames: ["schedule", "workflow_dispatch"],
    id: "github-actions-terraform-provider-braze-update-indirect-dependencies",
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    ref: "refs/heads/main",
    repository: "cysp/terraform-provider-braze",
    resource: "https://api.github.com/repos/cysp/terraform-provider-braze",
    workflowRef:
      "cysp/terraform-provider-braze/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
  }),
  githubActionsInstallationTokenRule({
    eventNames: ["schedule", "workflow_dispatch"],
    id: "github-actions-terraform-provider-censusworkspace-update-indirect-dependencies",
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    ref: "refs/heads/main",
    repository: "cysp/terraform-provider-censusworkspace",
    resource: "https://api.github.com/repos/cysp/terraform-provider-censusworkspace",
    workflowRef:
      "cysp/terraform-provider-censusworkspace/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
  }),
  githubActionsInstallationTokenRule({
    eventNames: ["schedule", "workflow_dispatch"],
    id: "github-actions-terraform-provider-contentful-update-indirect-dependencies",
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    ref: "refs/heads/main",
    repository: "cysp/terraform-provider-contentful",
    resource: "https://api.github.com/repos/cysp/terraform-provider-contentful",
    workflowRef:
      "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
  }),
  githubActionsInstallationTokenRule({
    eventNames: ["schedule", "workflow_dispatch"],
    id: "github-actions-terraform-provider-typesense-update-indirect-dependencies",
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    ref: "refs/heads/main",
    repository: "cysp/terraform-provider-typesense",
    resource: "https://api.github.com/repos/cysp/terraform-provider-typesense",
    workflowRef:
      "cysp/terraform-provider-typesense/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
  }),
] satisfies readonly TokenPolicyRule[]);
