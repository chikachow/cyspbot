import { githubActionsTrustedIssuer } from "@cyspbot/github-actions-oidc/issuer";
import {
  validateTokenPolicyRules,
  type TokenPolicyRule,
} from "@cyspbot/token-exchange/policy/token-policy";

import { testRepository, testWorkflowDispatchRepository } from "./constants.ts";

const testPrincipalRef = "refs/heads/fixture-base-branch";
const testPrincipalWorkflowRef = `${testRepository}/.github/workflows/fixture-token-request.yml@${testPrincipalRef}`;

export const testTokenPolicyRules = validateTokenPolicyRules([
  githubActionsRule({
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
  githubActionsRule({
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

export function githubActionsRule(options: {
  eventNames: readonly string[];
  id: string;
  permissions: Record<string, string>;
  ref: string;
  repository: string;
  resource: string;
  workflowRef: string;
}): TokenPolicyRule {
  return {
    effect: "allow",
    id: options.id,
    issue: {
      githubInstallationToken: {
        permissions: options.permissions,
        resource: options.resource,
      },
    },
    subject: {
      issuer: githubActionsTrustedIssuer.issuer,
    },
    when: [
      `claims["repository"] == ${celString(options.repository)}`,
      `claims["event_name"] in ${celStringList(options.eventNames)}`,
      `claims["ref_type"] == "branch"`,
      `claims["ref"] == ${celString(options.ref)}`,
      githubActionsSubjectCondition(options.repository, options.ref),
      `claims["workflow_ref"] == ${celString(options.workflowRef)}`,
    ].join(" && "),
  };
}

function githubActionsSubjectCondition(repository: string, ref: string): string {
  const [owner, repo] = repository.split("/");

  if (owner === undefined || repo === undefined) {
    throw new Error("GitHub Actions policy repository must be owner/repository");
  }

  const immutableSubjectPattern = celString(
    `^repo:${escapeCelRegex(owner)}@[^/@]+/${escapeCelRegex(repo)}@[^/@]+:ref:${escapeCelRegex(ref)}$`,
  );
  const immutableSubjectSuffix = celString(`/${repo}@`);
  const immutableSubjectRef = celString(`:ref:${ref}`);

  return [
    "(",
    `claims["sub"] == ${celString(`repo:${repository}:ref:${ref}`)}`,
    " || ",
    "(",
    '"repository_owner_id" in claims && claims["repository_owner_id"] != null && ',
    `claims["sub"] == ${celString(`repo:${owner}@`)} + claims["repository_owner_id"] + ${immutableSubjectSuffix} + claims["repository_id"] + ${immutableSubjectRef}`,
    ") || (",
    '(!("repository_owner_id" in claims) || claims["repository_owner_id"] == null) && ',
    `claims["sub"].matches(${immutableSubjectPattern}) && `,
    `claims["sub"].endsWith(${immutableSubjectSuffix} + claims["repository_id"] + ${immutableSubjectRef})`,
    ")",
    ")",
  ].join("");
}

function escapeCelRegex(value: string): string {
  return value.replaceAll(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function celString(value: string): string {
  return JSON.stringify(value);
}

function celStringList(values: readonly string[]): string {
  return `[${values.map(celString).join(", ")}]`;
}
