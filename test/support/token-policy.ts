import {
  validateTokenPolicyRules,
  type TokenPolicyRule,
} from "@cyspbot/token-exchange/policy/token-policy";

import { testRepository, testWorkflowDispatchRepository } from "./constants.ts";

const testPrincipalRef = "refs/heads/fixture-base-branch";
const testPrincipalWorkflowRef = `${testRepository}/.github/workflows/fixture-token-request.yml@${testPrincipalRef}`;

export const testTokenPolicyRules = validateTokenPolicyRules([
  {
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    principalEventNames: ["schedule", "workflow_dispatch"],
    principalRef: testPrincipalRef,
    principalRepository: testRepository,
    principalWorkflowRef: testPrincipalWorkflowRef,
    resource: `https://api.github.com/repos/${testRepository}`,
  },
  {
    permissions: {
      actions: "write",
    },
    principalEventNames: ["workflow_dispatch"],
    principalRef: testPrincipalRef,
    principalRepository: testRepository,
    principalWorkflowRef: testPrincipalWorkflowRef,
    resource: `https://api.github.com/repos/${testWorkflowDispatchRepository}`,
  },
] satisfies readonly TokenPolicyRule[]);
