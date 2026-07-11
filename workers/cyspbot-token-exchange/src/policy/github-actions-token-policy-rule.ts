import { githubActionsTrustedIssuer } from "@cyspbot/oidc-issuer-github-actions";
import type { TokenPolicyRule } from "./token-policy.ts";

export function githubActionsInstallationTokenRule(options: {
  eventNames: readonly string[];
  id: string;
  permissions: Record<string, string>;
  ref: string;
  repository: string;
  resource: string;
  workflowRef: string;
}): TokenPolicyRule {
  const [owner, repository, extra] = options.repository.split("/");

  if (!owner || !repository || extra !== undefined) {
    throw new Error("GitHub Actions policy repository must be owner/repository");
  }

  if (options.eventNames.length === 0 || !options.ref || !options.workflowRef) {
    throw new Error("GitHub Actions policy rule requires events, ref, and workflow ref");
  }

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
      githubActionsSubjectCondition(owner, repository, options.ref),
      `claims["workflow_ref"] == ${celString(options.workflowRef)}`,
    ].join(" && "),
  };
}

function githubActionsSubjectCondition(owner: string, repository: string, ref: string): string {
  const immutableSubjectPattern = celString(
    `^repo:${escapeCelRegex(owner)}@[^/@]+/${escapeCelRegex(repository)}@[^/@]+:ref:${escapeCelRegex(ref)}$`,
  );
  const immutableSubjectSuffix = celString(`/${repository}@`);
  const immutableSubjectRef = celString(`:ref:${ref}`);

  return [
    "(",
    `claims["sub"] == ${celString(`repo:${owner}/${repository}:ref:${ref}`)}`,
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
