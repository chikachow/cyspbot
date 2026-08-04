import {
  createOidcProviderRegistration,
  type OidcIdTokenProfile,
} from "@cyspbot/oidc/provider-registration";

const googleServiceAccountOidcIdTokenProfile: OidcIdTokenProfile = {
  validate: (claims) => claims["azp"] === claims.sub,
};

export const googleServiceAccountOidcProviderRegistration = createOidcProviderRegistration({
  acceptedIdTokenSigningAlgorithms: ["RS256"],
  idTokenProfile: googleServiceAccountOidcIdTokenProfile,
  issuer: "https://accounts.google.com",
});
