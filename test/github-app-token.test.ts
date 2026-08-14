import {
  GitHubAppTokenBrokerError,
  requestGitHubAppInstallationToken,
} from "@cyspbot/cyspbot/github-app-token";
import { describe, expect, it } from "vitest";

const workloadIdentityAudience = "https://cyspbot.local";
const brokerTokenEndpoint = "https://github-app-token-broker-local/token";
const resource = "https://api.github.com/repos/chikachow/cyspbot";
const scope = "contents:read";
const workloadIdentityToken = "eyJ.test.workload.identity";

describe("cyspbot OAuth Token Exchange Client", () => {
  it("uses the Workload Identity RPC binding before calling the broker", async () => {
    const events: string[] = [];
    let audience: string | undefined;
    const { env } = createEnv({
      onIssuerCall(value) {
        audience = value;
        events.push("issuer");
      },
      onBrokerCall() {
        events.push("broker");
      },
    });

    await requestGitHubAppInstallationToken(env, { resource, scope });

    expect(events).toEqual(["issuer", "broker"]);
    expect(audience).toBe(workloadIdentityAudience);
  });

  it("rejects a generated service binding without the RPC method", async () => {
    const { env } = createEnv({
      issuer: createGeneratedServiceBinding(),
    });

    await expect(requestGitHubAppInstallationToken(env, { resource, scope })).rejects.toThrow(
      "WORKLOAD_IDENTITY_ISSUER must expose issueToken()",
    );
  });

  it("returns a typed installation access token after the OAuth exchange", async () => {
    const requests: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const { env } = createEnv({
      onBrokerCall(input, init) {
        requests.push({ init, input });
      },
    });

    await expect(requestGitHubAppInstallationToken(env, { resource, scope })).resolves.toEqual({
      accessToken: "ghs_test_token",
      expiresIn: 300,
      scope,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe(brokerTokenEndpoint);
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.redirect).toBe("manual");
    expect(new Headers(requests[0]?.init?.headers).get("accept")).toBe("application/json");
    expect(new Headers(requests[0]?.init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );

    const requestBody = requests[0]?.init?.body;
    if (!(requestBody instanceof URLSearchParams)) {
      throw new TypeError("expected a URLSearchParams token-exchange body");
    }

    expect(Object.fromEntries(requestBody)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource,
      scope,
      subject_token: workloadIdentityToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    });
  });

  it.each([
    ["issued token type", { issued_token_type: "urn:example:token" }, "invalid issued token type"],
    ["token type", { token_type: "DPoP" }, "invalid token type"],
    ["expiration", { expires_in: 1.5 }, "invalid expiration"],
  ] as const)("rejects a success response with an invalid %s", async (_name, override, message) => {
    const { env } = createEnv({ response: createBrokerSuccessResponse(override) });

    await expect(requestGitHubAppInstallationToken(env, { resource, scope })).rejects.toThrow(
      message,
    );
  });

  it("does not contact either binding when the request is empty", async () => {
    let issuerCalls = 0;
    let brokerCalls = 0;
    const { env } = createEnv({
      onIssuerCall() {
        issuerCalls += 1;
      },
      onBrokerCall() {
        brokerCalls += 1;
      },
    });

    await expect(requestGitHubAppInstallationToken(env, { resource: "", scope })).rejects.toThrow(
      "resource must be a non-empty string",
    );
    expect(issuerCalls).toBe(0);
    expect(brokerCalls).toBe(0);
  });

  it("does not contact the broker when the issuer returns no token", async () => {
    let brokerCalls = 0;
    const { env } = createEnv({
      issuerToken: { token: "" },
      onBrokerCall() {
        brokerCalls += 1;
      },
    });

    await expect(requestGitHubAppInstallationToken(env, { resource, scope })).rejects.toThrow(
      "IssuedToken.token must be a non-empty string",
    );
    expect(brokerCalls).toBe(0);
  });

  it("rejects an issuer response that is not an IssuedToken", async () => {
    const { env } = createEnv({ issuerToken: "invalid" });

    await expect(requestGitHubAppInstallationToken(env, { resource, scope })).rejects.toThrow(
      "WORKLOAD_IDENTITY_ISSUER returned an invalid IssuedToken",
    );
  });

  it("requires a non-empty scope before contacting either binding", async () => {
    let issuerCalls = 0;
    let brokerCalls = 0;
    const { env } = createEnv({
      onIssuerCall() {
        issuerCalls += 1;
      },
      onBrokerCall() {
        brokerCalls += 1;
      },
    });

    await expect(requestGitHubAppInstallationToken(env, { resource, scope: " " })).rejects.toThrow(
      "scope must be a non-empty string",
    );
    expect(issuerCalls).toBe(0);
    expect(brokerCalls).toBe(0);
  });

  it("rejects a malformed successful broker response", async () => {
    const { env } = createEnv({ response: new Response("{", { status: 200 }) });

    await expect(requestGitHubAppInstallationToken(env, { resource, scope })).rejects.toThrow(
      "invalid token response",
    );
  });

  it("maps a malformed broker error response to invalid_response", async () => {
    const { env } = createEnv({ response: new Response(null, { status: 400 }) });

    await expect(requestGitHubAppInstallationToken(env, { resource, scope })).rejects.toEqual(
      expect.objectContaining({
        oauthErrorCode: "invalid_response",
        status: 400,
      } satisfies Partial<GitHubAppTokenBrokerError>),
    );
  });

  it("rejects an oversized broker response", async () => {
    const { env } = createEnv({
      response: new Response("x".repeat(64 * 1024 + 1), { status: 200 }),
    });

    await expect(requestGitHubAppInstallationToken(env, { resource, scope })).rejects.toThrow(
      "invalid token response",
    );
  });

  it("throws a typed error for broker OAuth failures", async () => {
    const { env } = createEnv({
      response: new Response(
        JSON.stringify({ error: "invalid_scope", error_description: "scope is not permitted" }),
        { headers: { "content-type": "application/json" }, status: 400 },
      ),
    });

    await expect(requestGitHubAppInstallationToken(env, { resource, scope })).rejects.toEqual(
      expect.objectContaining({
        message: "GitHub App token broker returned 400: invalid_scope",
        name: "GitHubAppTokenBrokerError",
        oauthErrorCode: "invalid_scope",
        oauthErrorDescription: "scope is not permitted",
        status: 400,
      } satisfies Partial<GitHubAppTokenBrokerError>),
    );
  });
});

type TestServiceBinding = ReturnType<typeof createGeneratedServiceBinding>;
type TestIssuer = TestServiceBinding | ReturnType<typeof createWorkloadIdentityIssuer>;

interface TestOptions {
  readonly issuer?: TestIssuer;
  readonly issuerToken?: unknown;
  readonly onBrokerCall?: (input: RequestInfo | URL, init: RequestInit | undefined) => void;
  readonly onIssuerCall?: (audience: string) => void;
  readonly response?: Response;
}

function createEnv(options: TestOptions = {}): { env: CyspbotEnv } {
  const issuer =
    options.issuer ??
    createWorkloadIdentityIssuer((audience) => {
      options.onIssuerCall?.(audience);
      return options.issuerToken ?? { token: workloadIdentityToken };
    });

  const env = {
    GITHUB_APP_TOKEN_BROKER: {
      ...createGeneratedServiceBinding(),
      fetch(input, init) {
        options.onBrokerCall?.(input, init);
        return Promise.resolve(options.response ?? createBrokerSuccessResponse());
      },
    },
    GITHUB_APP_TOKEN_BROKER_TOKEN_ENDPOINT: brokerTokenEndpoint,
    WORKLOAD_IDENTITY_ISSUER: issuer,
    WORKLOAD_IDENTITY_TOKEN_AUDIENCE: workloadIdentityAudience,
  } satisfies CyspbotEnv;

  return {
    env,
  };
}

function createBrokerSuccessResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      access_token: "ghs_test_token",
      expires_in: 300,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope,
      token_type: "Bearer",
      ...overrides,
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
}

function createGeneratedServiceBinding() {
  return {
    connect() {
      throw new Error("service binding connect() is not used by this test");
    },
    fetch() {
      return Promise.resolve(new Response(null, { status: 501 }));
    },
  };
}

function createWorkloadIdentityIssuer(issueToken: (audience: string) => unknown) {
  return {
    ...createGeneratedServiceBinding(),
    issueToken: (audience: string) => Promise.resolve(issueToken(audience)),
  };
}
