import { flyIssuerForOrgSlug } from "@cyspbot/oidc-issuer-fly";
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
  const issuer = flyIssuerForOrgSlug(options.orgSlug);

  if (issuer === null || !options.orgId || !options.appId) {
    throw new Error(
      "Fly Machine policy rule requires organization slug, organization ID, and app ID",
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
    subject: { issuer },
    when: [
      `claims["org_id"] == ${celString(options.orgId)}`,
      `claims["org_name"] == ${celString(options.orgSlug)}`,
      `claims["app_id"] == ${celString(options.appId)}`,
      'claims["sub"] == claims["org_name"] + ":" + claims["app_name"] + ":" + claims["machine_name"]',
      ...(options.machineId === undefined
        ? []
        : [`claims["machine_id"] == ${celString(options.machineId)}`]),
    ].join(" && "),
  };
}

function celString(value: string): string {
  return JSON.stringify(value);
}
