import { jsonResponse } from "@cyspbot/http/problem-details";
import { readRequestBodyUpTo } from "@cyspbot/http/request-body";
import { issueInstallationTokenForContext } from "./policy/installation-token-issuance.ts";
import { normalizeInstallationAccessTokenRequest } from "./policy/token-policy.ts";
import type { TokenExchangeDependencies } from "./dependencies.ts";

const maxTokenExchangeBodyBytes = 64 * 1024;
const tokenExchangeGrantType = "urn:ietf:params:oauth:grant-type:token-exchange";
const githubInstallationAccessTokenType = "urn:chikachow:github-app-installation-access-token";
const oidcIdTokenType = "urn:ietf:params:oauth:token-type:id_token";
const jwtTokenType = "urn:ietf:params:oauth:token-type:jwt";
const unknownRateLimitKey = "unknown";
const unsupportedInvalidRequestParameters = [
  "actor_token",
  "actor_token_type",
  "authorization_details",
  "client_assertion",
  "client_assertion_type",
  "client_id",
  "client_secret",
];

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

  if (request.headers.has("authorization")) {
    return oauthErrorResponse(401, "invalid_client", {
      "www-authenticate": wwwAuthenticateChallenge(request.headers.get("authorization")),
    });
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
  const tokenRequestOptions = parseInstallationAccessTokenRequestOptions(form);

  if (grantType === null) {
    return oauthErrorResponse(400, "invalid_request");
  }

  if (grantType !== tokenExchangeGrantType) {
    return oauthErrorResponse(400, "unsupported_grant_type");
  }

  if (subjectToken === null || subjectToken.length === 0 || subjectTokenType === null) {
    return oauthErrorResponse(400, "invalid_request");
  }

  if (subjectTokenType !== oidcIdTokenType && subjectTokenType !== jwtTokenType) {
    return oauthErrorResponse(400, "invalid_request");
  }

  if (requestedTokenType !== githubInstallationAccessTokenType) {
    return oauthErrorResponse(400, "invalid_request");
  }

  if (!tokenRequestOptions.ok) {
    return oauthErrorResponse(400, tokenRequestOptions.error);
  }

  const authentication = await dependencies.authenticateOidcToken(subjectToken, request);

  if (!authentication.ok) {
    return oauthErrorResponse(
      oauthStatusForAuthenticationFailure(authentication.reason),
      oauthErrorCodeForAuthenticationFailure(authentication.reason),
      authentication.responseHeaders,
    );
  }

  const tokenRequest = normalizeInstallationAccessTokenRequest(
    authentication.context.principal,
    tokenRequestOptions.options,
  );

  if (!tokenRequest.ok) {
    return oauthErrorResponse(400, tokenRequest.error);
  }

  const result = await issueInstallationTokenForContext(
    env,
    authentication.context,
    tokenRequest.tokenRequest,
    dependencies,
  );

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
    scope: tokenRequest.tokenRequest.scope,
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
  const values = nonEmptyFormValues(form, key);

  if (values.length !== 1) {
    return null;
  }

  return values[0] ?? null;
}

function optionalSingleFormValue(
  form: URLSearchParams,
  key: string,
): { ok: true; value: string | null } | { ok: false } {
  const values = nonEmptyFormValues(form, key);

  if (values.length === 0) {
    return { ok: true, value: null };
  }

  if (values.length !== 1) {
    return { ok: false };
  }

  return { ok: true, value: values[0] ?? null };
}

function hasNonEmptyFormValue(form: URLSearchParams, key: string): boolean {
  return nonEmptyFormValues(form, key).length > 0;
}

function nonEmptyFormValues(form: URLSearchParams, key: string): string[] {
  return form.getAll(key).filter((value) => value.length > 0);
}

function wwwAuthenticateChallenge(authorization: string | null): string {
  const scheme = authorization?.split(/\s+/u, 1)[0];

  if (scheme !== undefined && /^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*$/u.test(scheme)) {
    return `${scheme} realm="cyspbot"`;
  }

  return 'Basic realm="cyspbot"';
}

function optionalTokenRequestFormValue(
  form: URLSearchParams,
  key: string,
  blankError: string,
): { ok: true; value: string | null } | { error: string; ok: false } {
  const parsed = optionalSingleFormValue(form, key);

  if (!parsed.ok) {
    return { error: "invalid_request", ok: false };
  }

  if (parsed.value === null) {
    return { ok: true, value: null };
  }

  if (parsed.value.trim().length === 0) {
    return { error: blankError, ok: false };
  }

  return { ok: true, value: parsed.value };
}

function parseInstallationAccessTokenRequestOptions(form: URLSearchParams):
  | {
      ok: true;
      options: { resource: string | null; scope: string | null };
    }
  | { error: string; ok: false } {
  if (hasNonEmptyFormValue(form, "audience")) {
    return { error: "invalid_target", ok: false };
  }

  if (
    unsupportedInvalidRequestParameters.some((parameter) => hasNonEmptyFormValue(form, parameter))
  ) {
    return { error: "invalid_request", ok: false };
  }

  const scope = optionalTokenRequestFormValue(form, "scope", "invalid_scope");
  const resource = optionalTokenRequestFormValue(form, "resource", "invalid_target");

  if (!scope.ok) {
    return { error: scope.error, ok: false };
  }

  if (!resource.ok) {
    return { error: resource.error, ok: false };
  }

  return {
    ok: true,
    options: {
      resource: resource.value,
      scope: scope.value,
    },
  };
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

function oauthErrorResponse(status: number, error: string, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("pragma", "no-cache");

  return jsonResponse(
    { error },
    {
      headers: responseHeaders,
      status,
    },
  );
}

function oauthErrorCodeForAuthenticationFailure(
  reason: "invalid_token" | "oidc_provider_failure" | "oidc_verifier_failure",
): string {
  if (reason === "oidc_provider_failure") {
    return "temporarily_unavailable";
  }

  if (reason === "oidc_verifier_failure") {
    return "server_error";
  }

  return "invalid_request";
}

function oauthStatusForAuthenticationFailure(
  reason: "invalid_token" | "oidc_provider_failure" | "oidc_verifier_failure",
): number {
  if (reason === "oidc_provider_failure") {
    return 503;
  }

  if (reason === "oidc_verifier_failure") {
    return 500;
  }

  return 400;
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
