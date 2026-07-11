import { createPrivateKey } from "node:crypto";

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
  audience?: string | string[] | null;
  issuer?: string;
  kid?: string;
}

export interface TokenExchangeRequestBodyOptions {
  claims?: Partial<Record<string, unknown>>;
  form?: Partial<Record<string, string | null>>;
  requestedTokenType?: string | null;
  tokenOptions?: CreateOidcTokenOptions;
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

export async function createOidcToken(
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
    .setNotBefore(now - 10)
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

export async function fetchOidcJwksTestDouble(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init);

  const supportedJwksUrls = new Set([
    "https://token.actions.githubusercontent.com/.well-known/jwks",
    "https://oidc.fly.io/example-org/.well-known/jwks",
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
