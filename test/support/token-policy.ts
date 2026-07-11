import {
  validateTokenPolicyRules,
  type TokenPolicyRule,
} from "@cyspbot/token-exchange/policy/token-policy";
import { githubActionsInstallationTokenRule } from "../../workers/cyspbot-token-exchange/src/policy/github-actions-token-policy-rule.ts";

import { testRepository, testWorkflowDispatchRepository } from "./constants.ts";

const testPrincipalRef = "refs/heads/fixture-base-branch";
const testPrincipalWorkflowRef = `${testRepository}/.github/workflows/fixture-token-request.yml@${testPrincipalRef}`;

export const testTokenPolicyRules = validateTokenPolicyRules([
  githubActionsInstallationTokenRule({
    eventNames: ["schedule", "workflow_dispatch"],
    id: "test-github-same-repository",
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    ref: testPrincipalRef,
    repository: testRepository,
    resource: `https://api.github.com/repos/${testRepository}`,
    workflowRef: testPrincipalWorkflowRef,
  }),
  githubActionsInstallationTokenRule({
    eventNames: ["workflow_dispatch"],
    id: "test-github-cross-repository-actions",
    permissions: {
      actions: "write",
    },
    ref: testPrincipalRef,
    repository: testRepository,
    resource: `https://api.github.com/repos/${testWorkflowDispatchRepository}`,
    workflowRef: testPrincipalWorkflowRef,
  }),
] satisfies readonly TokenPolicyRule[]);
