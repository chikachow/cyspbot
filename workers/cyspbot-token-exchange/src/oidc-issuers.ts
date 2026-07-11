import { flyIssuerAdapter } from "@cyspbot/oidc-issuer-fly";
import { githubActionsIssuerAdapter } from "@cyspbot/oidc-issuer-github-actions";
import type { OidcIssuerAdapter } from "@cyspbot/oidc/issuer-adapter";

const configuredAdapterSets = new Map<string, readonly OidcIssuerAdapter[]>();

export function configuredOidcIssuerAdapters(env: {
  FLY_OIDC_ORG_SLUGS: string;
}): readonly OidcIssuerAdapter[] {
  const configuration = env.FLY_OIDC_ORG_SLUGS;
  const cachedAdapters = configuredAdapterSets.get(configuration);

  if (cachedAdapters !== undefined) {
    return cachedAdapters;
  }

  const adapters = [githubActionsIssuerAdapter, flyIssuerAdapter(configuration)];
  configuredAdapterSets.set(configuration, adapters);

  return adapters;
}
