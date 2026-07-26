import { googleServiceAccountOidcProviderRegistration } from "@cyspbot/oidc-provider-google-service-account";
import { celString } from "./cel-literals.ts";
import type { TokenPolicyRuleDefinition } from "./token-policy.ts";

export function googleServiceAccountInstallationAccessTokenRule(options: {
  email?: string;
  id: string;
  permissions: Record<string, string>;
  resource: string;
  uniqueId: string;
}): TokenPolicyRuleDefinition {
  return {
    effect: "allow",
    id: options.id,
    issue: {
      githubInstallationAccessToken: {
        permissions: options.permissions,
        resource: options.resource,
      },
    },
    subject: { issuer: googleServiceAccountOidcProviderRegistration.issuer },
    when: [
      `claims["sub"] == ${celString(options.uniqueId)}`,
      ...(options.email === undefined
        ? []
        : [`claims["email"] == ${celString(options.email)}`, `claims["email_verified"] == true`]),
    ].join(" && "),
  };
}
