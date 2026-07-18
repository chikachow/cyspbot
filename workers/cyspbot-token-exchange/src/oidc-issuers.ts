import { flyIssuerAdapter, flyIssuerIdentifierForOrganizationSlug } from "@cyspbot/oidc-issuer-fly";
import { githubActionsIssuerAdapter } from "@cyspbot/oidc-issuer-github-actions";
import type { OidcIssuerAdapter } from "@cyspbot/oidc/issuer-adapter";

const configuredAdapterSets = new Map<string | undefined, readonly OidcIssuerAdapter[]>();

export function configuredOidcIssuerAdapters(env: {
  FLY_OIDC_ORG_SLUGS?: string;
}): readonly OidcIssuerAdapter[] {
  const configuration = env.FLY_OIDC_ORG_SLUGS;
  const cachedAdapters = configuredAdapterSets.get(configuration);

  if (cachedAdapters !== undefined) {
    return cachedAdapters;
  }

  if (configuration === undefined) {
    console.error("oidc_issuer_configuration_binding_missing", {
      binding: "FLY_OIDC_ORG_SLUGS",
    });

    const adapters = Object.freeze([githubActionsIssuerAdapter]);
    configuredAdapterSets.set(configuration, adapters);

    return adapters;
  }

  const flyAdapters: OidcIssuerAdapter[] = [];
  const seenOrgSlugs = new Set<string>();

  for (const [entryIndex, entry] of configuration.split(",").entries()) {
    const orgSlug = entry.trim();

    if (orgSlug.length === 0 || seenOrgSlugs.has(orgSlug)) {
      continue;
    }

    seenOrgSlugs.add(orgSlug);

    if (flyIssuerIdentifierForOrganizationSlug(orgSlug) === null) {
      console.error("oidc_issuer_configuration_entry_invalid", {
        binding: "FLY_OIDC_ORG_SLUGS",
        entryIndex,
        reason: "unsupported_fly_issuer_path_syntax",
      });
      continue;
    }

    flyAdapters.push(flyIssuerAdapter(orgSlug));
  }

  const adapters = Object.freeze([...flyAdapters, githubActionsIssuerAdapter]);
  configuredAdapterSets.set(configuration, adapters);

  return adapters;
}
