import { createPrivateKey } from "node:crypto";

import { githubActionsTrustedIssuer } from "@cyspbot/github-actions-oidc/issuer";
import { OidcTokenVerifier } from "@cyspbot/oidc/verifier";
import { SignJWT } from "jose";

import {
  githubInstallationAccessTokenType,
  oidcIdTokenType,
  testPrivateKeyPem,
  testPublicJwk,
  tokenExchangeGrantType,
} from "./constants.ts";

export { githubInstallationAccessTokenType, testPublicJwk } from "./constants.ts";

export interface CreateOidcTokenOptions {
  audience?: string | string[];
  issuer?: string;
  kid?: string;
}

export const testOidcVerifier = new OidcTokenVerifier({
  fetchJwks: fetchOidcJwksTestDouble,
  issuer: githubActionsTrustedIssuer,
});

export function authorizationHeaders(
  overrides?: Partial<Record<string, unknown>>,
  tokenOptions?: CreateOidcTokenOptions,
): Promise<Record<string, string>> {
  return createOidcToken(overrides, tokenOptions).then((token) => ({
    authorization: `Bearer ${token}`,
  }));
}

export async function tokenExchangeRequestBody(
  overrides?: Partial<Record<string, unknown>>,
  requestedTokenType = githubInstallationAccessTokenType,
  tokenOptions?: CreateOidcTokenOptions,
): Promise<string> {
  const subjectToken = await createOidcToken(overrides, tokenOptions);

  return new URLSearchParams({
    grant_type: tokenExchangeGrantType,
    requested_token_type: requestedTokenType,
    subject_token: subjectToken,
    subject_token_type: oidcIdTokenType,
  }).toString();
}

export async function createOidcToken(
  overrides?: Partial<Record<string, unknown>>,
  options?: CreateOidcTokenOptions,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = createPrivateKey(testPrivateKeyPem);
  const { sub, ...payloadOverrides } = overrides ?? {};

  return new SignJWT({
    actor: "dependabot[bot]",
    base_ref: "",
    event_name: "workflow_dispatch",
    head_ref: "",
    job_workflow_ref:
      "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
    ref: "refs/heads/main",
    ref_type: "branch",
    repository: "cysp/terraform-provider-contentful",
    repository_id: "123456789",
    repository_owner_id: "555555",
    repository_visibility: "private",
    run_attempt: "1",
    run_id: "987654321",
    sha: "0123456789abcdef0123456789abcdef01234567",
    workflow: "update indirect dependencies",
    workflow_ref:
      "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
    ...payloadOverrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: options?.kid ?? "test-key-1" })
    .setAudience(options?.audience ?? "cyspbot")
    .setIssuer(options?.issuer ?? "https://token.actions.githubusercontent.com")
    .setIssuedAt(now - 10)
    .setNotBefore(now - 10)
    .setExpirationTime(now + 300)
    .setSubject(
      typeof sub === "string" ? sub : "repo:cysp/terraform-provider-contentful:ref:refs/heads/main",
    )
    .sign(privateKey);
}

async function fetchOidcJwksTestDouble(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init);

  if (
    request.method !== "GET" ||
    request.url !== "https://token.actions.githubusercontent.com/.well-known/jwks"
  ) {
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
