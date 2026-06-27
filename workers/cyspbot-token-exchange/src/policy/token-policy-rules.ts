import { validateTokenPolicyRules, type TokenPolicyRule } from "./token-policy.ts";

export const tokenPolicyRules = validateTokenPolicyRules([
  {
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    principalEventNames: ["schedule", "workflow_dispatch"],
    principalRef: "refs/heads/main",
    principalRepository: "chikachow/cyspbot",
    principalWorkflowRef: "chikachow/cyspbot/.github/workflows/pnpm-up.yml@refs/heads/main",
    resource: "https://api.github.com/repos/chikachow/cyspbot",
  },
  {
    permissions: {
      actions: "write",
    },
    principalEventNames: ["push", "workflow_dispatch"],
    principalRef: "refs/heads/main",
    principalRepository: "chikachow/cyspbot",
    principalWorkflowRef:
      "chikachow/cyspbot/.github/workflows/trigger-cyspbot-deploy-update.yml@refs/heads/main",
    resource: "https://api.github.com/repos/chikachow/cyspbot-deploy",
  },
  {
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    principalEventNames: ["workflow_dispatch"],
    principalRef: "refs/heads/main",
    principalRepository: "chikachow/cyspbot-deploy",
    principalWorkflowRef:
      "chikachow/cyspbot-deploy/.github/workflows/update-cyspbot.yml@refs/heads/main",
    resource: "https://api.github.com/repos/chikachow/cyspbot-deploy",
  },
  {
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    principalEventNames: ["schedule", "workflow_dispatch"],
    principalRef: "refs/heads/main",
    principalRepository: "chikachow/cyspbot-app-token-action",
    principalWorkflowRef:
      "chikachow/cyspbot-app-token-action/.github/workflows/pnpm-up.yml@refs/heads/main",
    resource: "https://api.github.com/repos/chikachow/cyspbot-app-token-action",
  },
  {
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    principalEventNames: ["schedule", "workflow_dispatch"],
    principalRef: "refs/heads/main",
    principalRepository: "cysp/graphql-schema-registry",
    principalWorkflowRef:
      "cysp/graphql-schema-registry/.github/workflows/pnpm-up.yml@refs/heads/main",
    resource: "https://api.github.com/repos/cysp/graphql-schema-registry",
  },
  {
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    principalEventNames: ["schedule", "workflow_dispatch"],
    principalRef: "refs/heads/main",
    principalRepository: "cysp/terraform-provider-braze",
    principalWorkflowRef:
      "cysp/terraform-provider-braze/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
    resource: "https://api.github.com/repos/cysp/terraform-provider-braze",
  },
  {
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    principalEventNames: ["schedule", "workflow_dispatch"],
    principalRef: "refs/heads/main",
    principalRepository: "cysp/terraform-provider-censusworkspace",
    principalWorkflowRef:
      "cysp/terraform-provider-censusworkspace/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
    resource: "https://api.github.com/repos/cysp/terraform-provider-censusworkspace",
  },
  {
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    principalEventNames: ["schedule", "workflow_dispatch"],
    principalRef: "refs/heads/main",
    principalRepository: "cysp/terraform-provider-contentful",
    principalWorkflowRef:
      "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
    resource: "https://api.github.com/repos/cysp/terraform-provider-contentful",
  },
  {
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    principalEventNames: ["schedule", "workflow_dispatch"],
    principalRef: "refs/heads/main",
    principalRepository: "cysp/terraform-provider-typesense",
    principalWorkflowRef:
      "cysp/terraform-provider-typesense/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
    resource: "https://api.github.com/repos/cysp/terraform-provider-typesense",
  },
] satisfies readonly TokenPolicyRule[]);
