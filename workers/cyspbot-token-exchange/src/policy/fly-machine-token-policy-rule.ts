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
    when: [
      `claims["org_id"] == ${celString(options.orgId)}`,
      `claims["app_id"] == ${celString(options.appId)}`,
      ...(options.machineId === undefined
        ? []
        : [`claims["machine_id"] == ${celString(options.machineId)}`]),
    ].join(" && "),
  };
}
