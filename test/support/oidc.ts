import { createPrivateKey } from "node:crypto";

import { SignJWT } from "jose";

import { parseOidcIssuerIdentifier } from "@cyspbot/oidc/provider-registration";
import type { VerifiedSubjectToken } from "@cyspbot/token-exchange/authentication";
import {
  githubInstallationAccessTokenType,
  oidcIdTokenType,
  testPrivateKeyPem,
  testPublicJwk,
  testRepository,
  tokenExchangeGrantType,
} from "./constants.ts";

export { githubInstallationAccessTokenType } from "./constants.ts";

export interface CreateOidcTokenOptions {
  audience?: string | string[] | null;
  issuer?: string;
  kid?: string;
  notBefore?: number;
}

export interface TokenExchangeRequestBodyOptions {
  claims?: Partial<Record<string, unknown>>;
  form?: Partial<Record<string, string | null>>;
  requestedTokenType?: string | null;
  tokenOptions?: CreateOidcTokenOptions;
}

export function createVerifiedSubjectToken(
  claims: Partial<VerifiedSubjectToken["claims"]> = {},
  options: { issuer?: string } = {},
): VerifiedSubjectToken {
  const now = Math.floor(Date.now() / 1000);
  const issuer = parseOidcIssuerIdentifier(
    options.issuer ?? "https://token.actions.githubusercontent.com",
  );

  if (issuer === null) {
    throw new TypeError("test Verified Subject Token requires a valid OIDC Issuer Identifier");
  }

  return {
    claims: {
      aud: "cyspbot",
      exp: now + 300,
      iat: now - 10,
      iss: issuer,
      sub: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
      ...claims,
    },
    issuer,
  };
}

export function authorizationHeaders(
  overrides?: Partial<Record<string, unknown>>,
  tokenOptions?: CreateOidcTokenOptions,
): Promise<Record<string, string>> {
  return createOidcToken(overrides, tokenOptions).then((token) => ({
    authorization: `Bearer ${token}`,
  }));
}

export async function tokenExchangeRequestBody({
  claims,
  form: formOptions,
  requestedTokenType = githubInstallationAccessTokenType,
  tokenOptions,
}: TokenExchangeRequestBodyOptions = {}): Promise<string> {
  const subjectToken = await createOidcToken(claims, tokenOptions);
  const form = new URLSearchParams({
    grant_type: tokenExchangeGrantType,
    resource: `https://api.github.com/repos/${testRepository}`,
    subject_token: subjectToken,
    subject_token_type: oidcIdTokenType,
  });

  if (requestedTokenType !== null) {
    form.set("requested_token_type", requestedTokenType);
  }

  for (const [key, value] of Object.entries(formOptions ?? {})) {
    if (value === null) {
      form.delete(key);
    } else if (value !== undefined) {
      form.set(key, value);
    }
  }

  return form.toString();
}

async function createOidcToken(
  overrides?: Partial<Record<string, unknown>>,
  options?: CreateOidcTokenOptions,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = createPrivateKey(testPrivateKeyPem);
  const { sub, ...payloadOverrides } = overrides ?? {};
  const audience = options?.audience === undefined ? "cyspbot" : options.audience;
  let jwt = new SignJWT({
    actor: "dependabot[bot]",
    base_ref: "",
    event_name: "workflow_dispatch",
    head_ref: "",
    ref: "refs/heads/fixture-base-branch",
    ref_type: "branch",
    repository: "fixture-owner/fixture-source-repository",
    repository_id: "123456789",
    repository_owner_id: "555555",
    repository_visibility: "private",
    run_attempt: "1",
    run_id: "987654321",
    sha: "0123456789abcdef0123456789abcdef01234567",
    workflow: "fixture token request",
    workflow_ref:
      "fixture-owner/fixture-source-repository/.github/workflows/fixture-token-request.yml@refs/heads/fixture-base-branch",
    ...payloadOverrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: options?.kid ?? "test-key-1" })
    .setIssuer(options?.issuer ?? "https://token.actions.githubusercontent.com")
    .setIssuedAt(now - 10)
    .setNotBefore(options?.notBefore ?? now - 10)
    .setExpirationTime(now + 300)
    .setSubject(
      typeof sub === "string"
        ? sub
        : "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
    );

  if (audience !== null) {
    jwt = jwt.setAudience(audience);
  }

  return jwt.sign(privateKey);
}

export async function fetchOidcRemoteDocumentResponseTestDouble(input: RequestInfo | URL) {
  const request = new Request(input);
  const providerMetadata = new Map<string, { issuer: string; jwksUri: string }>([
    [
      "https://token.actions.githubusercontent.com/.well-known/openid-configuration",
      {
        issuer: "https://token.actions.githubusercontent.com",
        jwksUri: "https://token.actions.githubusercontent.com/.well-known/jwks",
      },
    ],
    [
      "https://accounts.google.com/.well-known/openid-configuration",
      {
        issuer: "https://accounts.google.com",
        jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
      },
    ],
    ...["example-org", "first-org", "second-org"].map(
      (organizationSlug) =>
        [
          `https://oidc.fly.io/${organizationSlug}/.well-known/openid-configuration`,
          {
            issuer: `https://oidc.fly.io/${organizationSlug}`,
            jwksUri: `https://oidc.fly.io/${organizationSlug}/.well-known/jwks`,
          },
        ] as const,
    ),
  ]);
  const metadata = providerMetadata.get(request.url);

  if (request.method === "GET" && metadata !== undefined) {
    return Response.json(
      {
        id_token_signing_alg_values_supported: ["RS256"],
        issuer: metadata.issuer,
        jwks_uri: metadata.jwksUri,
      },
      { headers: { "cache-control": "max-age=300" } },
    );
  }

  const supportedJwksUrls = new Set([
    "https://token.actions.githubusercontent.com/.well-known/jwks",
    "https://oidc.fly.io/example-org/.well-known/jwks",
    "https://oidc.fly.io/first-org/.well-known/jwks",
    "https://oidc.fly.io/second-org/.well-known/jwks",
    "https://www.googleapis.com/oauth2/v3/certs",
  ]);

  if (request.method !== "GET" || !supportedJwksUrls.has(request.url)) {
    return new Response(null, { status: 404 });
  }

  return Response.json(
    {
      keys: [testPublicJwk],
    },
    {
      headers: {
        "cache-control": "max-age=300",
      },
    },
  );
}
