import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type FetchImplementation,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export interface TrustedOidcIssuer {
  allowedSigningAlgorithms: readonly string[];
  audience: string;
  issuer: string;
  jwksUri: URL;
  trustedAdditionalAudiences?: readonly string[];
}

export interface VerifiedOidcToken {
  claims: JWTPayload;
  issuer: string;
  resolvedKeyId: string | null;
}

export interface OidcTokenVerifierOptions {
  fetchJwks?: typeof fetch;
  issuer: TrustedOidcIssuer;
}

export class OidcTokenVerifier {
  readonly #issuer: TrustedOidcIssuer;
  readonly #remoteJwks: JWTVerifyGetKey;

  public constructor(options: OidcTokenVerifierOptions) {
    this.#issuer = options.issuer;
    this.#remoteJwks = remoteJwks(options.issuer.jwksUri, options.fetchJwks);
  }

  public async verify(token: string): Promise<VerifiedOidcToken | null> {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.#remoteJwks, {
        algorithms: [...this.#issuer.allowedSigningAlgorithms],
        audience: this.#issuer.audience,
        issuer: this.#issuer.issuer,
      });

      if (!hasTrustedAudience(payload.aud, this.#issuer)) {
        return null;
      }

      if (!hasTrustedAuthorizedParty(payload["azp"], this.#issuer.audience)) {
        return null;
      }

      return {
        claims: payload,
        issuer: this.#issuer.issuer,
        resolvedKeyId: typeof protectedHeader.kid === "string" ? protectedHeader.kid : null,
      };
    } catch {
      return null;
    }
  }
}

function hasTrustedAudience(audience: JWTPayload["aud"], issuer: TrustedOidcIssuer): boolean {
  if (typeof audience === "string") {
    return audience === issuer.audience;
  }

  if (!Array.isArray(audience) || !audience.includes(issuer.audience)) {
    return false;
  }

  const trustedAudiences = new Set([issuer.audience, ...(issuer.trustedAdditionalAudiences ?? [])]);

  return audience.every((entry) => trustedAudiences.has(entry));
}

function hasTrustedAuthorizedParty(authorizedParty: JWTPayload["azp"], audience: string): boolean {
  return authorizedParty === undefined || authorizedParty === audience;
}

function remoteJwks(jwksUri: URL, fetchJwks: typeof fetch | undefined): JWTVerifyGetKey {
  if (fetchJwks !== undefined) {
    return createRemoteJWKSet(jwksUri, {
      [customFetch]: ((url, options) => fetchJwks(url, options)) satisfies FetchImplementation,
    });
  }

  return createRemoteJWKSet(jwksUri);
}
