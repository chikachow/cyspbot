import { readBodyUpTo } from "@cyspbot/http/body";

const tokenExchangeGrantType = "urn:ietf:params:oauth:grant-type:token-exchange";
const requestedTokenType = "urn:ietf:params:oauth:token-type:access_token";
const subjectTokenType = "urn:ietf:params:oauth:token-type:id_token";
const accessTokenScheme = "Bearer";
const maxBrokerResponseBytes = 64 * 1024;
const maxOAuthErrorDescriptionLength = 1024;

export interface GitHubAppInstallationTokenRequest {
  readonly resource: string;
  readonly scope: string;
}

export interface GitHubAppInstallationAccessToken {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly scope: string;
}

export class GitHubAppTokenBrokerError extends Error {
  readonly status: number;
  readonly oauthErrorCode: string;
  readonly oauthErrorDescription: string | undefined;

  constructor(status: number, oauthErrorCode: string, oauthErrorDescription?: string) {
    super(`GitHub App token broker returned ${status}: ${oauthErrorCode}`);
    this.name = "GitHubAppTokenBrokerError";
    this.status = status;
    this.oauthErrorCode = oauthErrorCode;
    this.oauthErrorDescription = oauthErrorDescription;
  }
}

export interface TokenExchangeEnvironment {
  readonly GITHUB_APP_TOKEN_BROKER: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  readonly GITHUB_APP_TOKEN_BROKER_TOKEN_ENDPOINT: string;
  readonly WORKLOAD_IDENTITY_ISSUER: unknown;
  readonly WORKLOAD_IDENTITY_TOKEN_AUDIENCE: string;
}

interface WorkloadIdentityIssuerBinding {
  issueToken(audience: string): Promise<unknown>;
}

export async function requestGitHubAppInstallationToken(
  env: TokenExchangeEnvironment,
  request: GitHubAppInstallationTokenRequest,
): Promise<GitHubAppInstallationAccessToken> {
  const resource = requireNonEmptyString(request.resource, "resource");
  const scope = requireNonEmptyString(request.scope, "scope");
  const issuer = requireWorkloadIdentityIssuer(env.WORKLOAD_IDENTITY_ISSUER);
  const issuedToken = await issuer.issueToken(env.WORKLOAD_IDENTITY_TOKEN_AUDIENCE);
  const subjectToken = requireIssuedToken(issuedToken);

  const response = await env.GITHUB_APP_TOKEN_BROKER.fetch(
    env.GITHUB_APP_TOKEN_BROKER_TOKEN_ENDPOINT,
    {
      body: new URLSearchParams({
        grant_type: tokenExchangeGrantType,
        requested_token_type: requestedTokenType,
        resource,
        scope,
        subject_token: subjectToken,
        subject_token_type: subjectTokenType,
      }),
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      redirect: "manual",
    },
  );

  if (!response.ok) {
    throw await readBrokerError(response);
  }

  return readInstallationAccessToken(response);
}

function requireWorkloadIdentityIssuer(value: unknown): WorkloadIdentityIssuerBinding {
  if (!isWorkloadIdentityIssuerBinding(value)) {
    throw new TypeError("WORKLOAD_IDENTITY_ISSUER must expose issueToken().");
  }

  return value;
}

function requireIssuedToken(value: unknown): string {
  if (!isRecord(value)) {
    throw new TypeError("WORKLOAD_IDENTITY_ISSUER returned an invalid IssuedToken.");
  }

  return requireNonEmptyString(value["token"], "IssuedToken.token");
}

async function readBrokerError(response: Response): Promise<GitHubAppTokenBrokerError> {
  const body = await readJsonBody(response);

  if (!isRecord(body)) {
    return new GitHubAppTokenBrokerError(response.status, "invalid_response");
  }

  const error = body["error"];
  const descriptionValue = body["error_description"];
  const code = typeof error === "string" && error.length > 0 ? error : "invalid_response";
  const description =
    typeof descriptionValue === "string" &&
    descriptionValue.length > 0 &&
    descriptionValue.length <= maxOAuthErrorDescriptionLength
      ? descriptionValue
      : undefined;

  return new GitHubAppTokenBrokerError(response.status, code, description);
}

async function readInstallationAccessToken(
  response: Response,
): Promise<GitHubAppInstallationAccessToken> {
  const body = await readJsonBody(response);

  if (!isRecord(body)) {
    throw new TypeError("GitHub App token broker returned an invalid token response.");
  }

  const expiresIn = body["expires_in"];
  if (typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn <= 0) {
    throw new TypeError("GitHub App token broker returned an invalid expiration.");
  }

  if (body["issued_token_type"] !== requestedTokenType) {
    throw new TypeError("GitHub App token broker returned an invalid issued token type.");
  }

  if (body["token_type"] !== accessTokenScheme) {
    throw new TypeError("GitHub App token broker returned an invalid token type.");
  }

  return {
    accessToken: requireNonEmptyString(body["access_token"], "access_token"),
    expiresIn,
    scope: requireNonEmptyString(body["scope"], "scope"),
  };
}

async function readJsonBody(response: Response): Promise<unknown> {
  const body = await readBodyUpTo(response.body, maxBrokerResponseBytes);

  if (!body.ok) {
    return undefined;
  }

  try {
    return JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return undefined;
  }
}

function isWorkloadIdentityIssuerBinding(value: unknown): value is WorkloadIdentityIssuerBinding {
  return isRecord(value) && typeof value["issueToken"] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }

  return value;
}
