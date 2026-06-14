import { jsonResponse } from "@cyspbot/http/problem-details";
import { readRequestBodyUpTo } from "@cyspbot/http/request-body";
import { issueInstallationTokenForContext } from "./policy/installation-token-issuance.ts";
import type { TokenExchangeDependencies } from "./dependencies.ts";

const maxTokenExchangeBodyBytes = 64 * 1024;
const tokenExchangeGrantType = "urn:ietf:params:oauth:grant-type:token-exchange";
const githubInstallationAccessTokenType = "urn:chikachow:github-app-installation-access-token";
const oidcIdTokenType = "urn:ietf:params:oauth:token-type:id_token";
const jwtTokenType = "urn:ietf:params:oauth:token-type:jwt";
const oauthAccessTokenType = "urn:ietf:params:oauth:token-type:access_token";
const unknownRateLimitKey = "unknown";

export function tokenExchangeMethodNotAllowedResponse(): Response {
  return oauthErrorResponse(400, "invalid_request");
}

export async function handleTokenExchangeRequest(
  request: Request,
  env: TokenExchangeBindings,
  dependencies: TokenExchangeDependencies,
): Promise<Response> {
  const rateLimit = await env.TOKEN_EXCHANGE_RATE_LIMIT.limit({
    key: tokenExchangeRateLimitKey(request),
  });

  if (!rateLimit.success) {
    return oauthErrorResponse(429, "temporarily_unavailable");
  }

  if (!isFormUrlEncodedContentType(request.headers.get("content-type"))) {
    return oauthErrorResponse(400, "invalid_request");
  }

  const body = await readRequestBodyUpTo(request, maxTokenExchangeBodyBytes);

  if (!body.ok) {
    return oauthErrorResponse(body.status, "invalid_request");
  }

  const form = new URLSearchParams(new TextDecoder().decode(body.bytes));
  const grantType = singleFormValue(form, "grant_type");
  const requestedTokenType = singleFormValue(form, "requested_token_type");
  const subjectToken = singleFormValue(form, "subject_token");
  const subjectTokenType = singleFormValue(form, "subject_token_type");

  if (grantType !== tokenExchangeGrantType) {
    return oauthErrorResponse(400, "unsupported_grant_type");
  }

  if (subjectToken === null || subjectToken.length === 0 || subjectTokenType === null) {
    return oauthErrorResponse(400, "invalid_request");
  }

  if (subjectTokenType !== oidcIdTokenType && subjectTokenType !== jwtTokenType) {
    return oauthErrorResponse(400, "invalid_request");
  }

  if (
    requestedTokenType !== null &&
    requestedTokenType !== githubInstallationAccessTokenType &&
    requestedTokenType !== oauthAccessTokenType
  ) {
    return oauthErrorResponse(400, "invalid_request");
  }

  const authentication = await dependencies.authenticateOidcToken(subjectToken, request);

  if (!authentication.ok) {
    return oauthErrorResponse(
      authentication.httpStatus === 500 ? 500 : 400,
      authentication.httpStatus === 500 ? "server_error" : "invalid_request",
    );
  }

  const result = await issueInstallationTokenForContext(env, authentication.context, dependencies);

  if (!result.ok) {
    return oauthErrorResponse(
      oauthStatusForIssuanceFailure(result.status),
      oauthErrorCodeForIssuanceFailure(result.status),
    );
  }

  return oauthTokenResponse({
    access_token: result.token,
    expires_in: expiresInSeconds(result.expiresAt, dependencies.now()),
    issued_token_type: githubInstallationAccessTokenType,
    token_type: "Bearer",
  });
}

function isFormUrlEncodedContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }

  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

function singleFormValue(form: URLSearchParams, key: string): string | null {
  const values = form.getAll(key);

  if (values.length !== 1) {
    return null;
  }

  return values[0] ?? null;
}

function oauthTokenResponse(body: Record<string, number | string>): Response {
  return jsonResponse(body, {
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
    },
    status: 200,
  });
}

function oauthErrorResponse(status: number, error: string): Response {
  return jsonResponse(
    { error },
    {
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache",
      },
      status,
    },
  );
}

function oauthErrorCodeForIssuanceFailure(status: number): string {
  if (status === 403) {
    return "invalid_target";
  }

  return "server_error";
}

function oauthStatusForIssuanceFailure(status: number): number {
  if (status === 403) {
    return 400;
  }

  if (status === 502) {
    return 502;
  }

  return 500;
}

function expiresInSeconds(expiresAt: string, now: Date): number {
  const expiresAtMs = Date.parse(expiresAt);

  if (Number.isNaN(expiresAtMs)) {
    return 0;
  }

  return Math.max(0, Math.floor((expiresAtMs - now.getTime()) / 1000));
}

function tokenExchangeRateLimitKey(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ??
    unknownRateLimitKey
  );
}
