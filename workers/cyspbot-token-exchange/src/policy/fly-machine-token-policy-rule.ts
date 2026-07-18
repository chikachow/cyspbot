import { flyIssuerIdentifierForOrganizationSlug } from "@cyspbot/oidc-issuer-fly";
import { celString } from "./cel-literals.ts";
import type { TokenPolicyRule } from "./token-policy.ts";

export function flyMachineInstallationTokenRule(options: {
  appId: string;
  id: string;
  machineId?: string;
  orgId: string;
  orgSlug: string;
  permissions: Record<string, string>;
  resource: string;
}): TokenPolicyRule {
  const issuerIdentifier = flyIssuerIdentifierForOrganizationSlug(options.orgSlug);

  if (issuerIdentifier === null || !options.orgId || !options.appId) {
    throw new Error(
      "Fly Machine policy rule requires Fly Organization Slug, organization ID, and Fly App ID",
    );
  }

  if (options.machineId !== undefined && options.machineId.length === 0) {
    throw new Error("Fly Machine policy rule Machine ID must not be empty");
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
    subject: { issuer: issuerIdentifier },
    // Reassert adapter-owned identity consistency at the authorization boundary.
    // This keeps policy fail-closed if it is ever evaluated with a malformed context.
    when: [
      `claims["org_id"] == ${celString(options.orgId)}`,
      `claims["org_name"] == ${celString(options.orgSlug)}`,
      `claims["app_id"] == ${celString(options.appId)}`,
      'claims["app_name"].matches(".+")',
      ...(options.machineId === undefined
        ? ['claims["machine_id"].matches(".+")']
        : [`claims["machine_id"] == ${celString(options.machineId)}`]),
      'claims["machine_name"].matches(".+")',
      'claims["machine_version"].matches(".+")',
      'claims["sub"] == claims["org_name"] + ":" + claims["app_name"] + ":" + claims["machine_name"]',
    ].join(" && "),
  };
}
