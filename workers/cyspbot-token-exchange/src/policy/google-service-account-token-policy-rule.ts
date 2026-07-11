import { googleServiceAccountTrustedIssuer } from "@cyspbot/oidc-issuer-google-service-account";
import { celString } from "./cel-literals.ts";
import type { TokenPolicyRule } from "./token-policy.ts";

export function googleServiceAccountInstallationTokenRule(options: {
  email?: string;
  id: string;
  permissions: Record<string, string>;
  resource: string;
  uniqueId: string;
}): TokenPolicyRule {
  if (!options.uniqueId) {
    throw new Error("Google service-account policy rule requires a unique ID");
  }

  if (options.email !== undefined && options.email.length === 0) {
    throw new Error("Google service-account policy rule email must not be empty");
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
    subject: { issuer: googleServiceAccountTrustedIssuer.issuer },
    // Reassert the adapter-owned service-account binding at the authorization boundary.
    // This keeps policy fail-closed if it is ever evaluated with a malformed context.
    when: [
      `claims["sub"] == ${celString(options.uniqueId)}`,
      `claims["azp"] == claims["sub"]`,
      ...(options.email === undefined
        ? []
        : [`claims["email"] == ${celString(options.email)}`, `claims["email_verified"] == true`]),
    ].join(" && "),
  };
}
