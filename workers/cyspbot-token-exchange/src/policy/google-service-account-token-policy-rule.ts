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
    when: [
      `claims["sub"] == ${celString(options.uniqueId)}`,
      ...(options.email === undefined
        ? []
        : [`claims["email"] == ${celString(options.email)}`, `claims["email_verified"] == true`]),
    ].join(" && "),
  };
}
