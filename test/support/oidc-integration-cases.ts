export const tokenExchangeOidcIntegrationCases = [
  {
    error: "invalid_request",
    organizationSlug: "integration-direct",
    scenario: "direct",
    status: 400,
  },
  {
    error: "temporarily_unavailable",
    organizationSlug: "integration-provider-redirect",
    scenario: "provider-redirect",
    status: 503,
  },
  {
    error: "temporarily_unavailable",
    organizationSlug: "integration-jwks-redirect",
    scenario: "jwks-redirect",
    status: 503,
  },
] as const;

type TokenExchangeOidcIntegrationCase = (typeof tokenExchangeOidcIntegrationCases)[number];

export function flyOidcIntegrationIssuer(testCase: TokenExchangeOidcIntegrationCase): string {
  return `https://oidc.fly.io/${testCase.organizationSlug}`;
}
