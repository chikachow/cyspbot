import { createPrivateKey } from "node:crypto";

import { SELF } from "cloudflare:test";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

const testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC27Vu1+aKPooBG
8zJHy9cbx0FAO26Fk2HnzYpl/Tm7POL6Pxzht2HO6GOTEv7OKz7o0TzG6XdDz5ci
+IP6eKHVPPRupH7wbYOqxp4zRhPMaVaaJFQ27ApXANOKxz+UBjGe/JMFQaTA/O3k
NJ0WoNXlMUDDWlLzmkz767EmqkrOeDO+/I11BSw3r07Kheu1C5LZ/Bv/IE1JINsV
NzzN4cVHXmI9HXkLAHwDzeUs0cu7ar6Vxfl4ON5lDptwKptntfU4nn7p1zZK9q0Q
QVjPRVwhaLy+XofSoO57xf5euJyYDxa9T3iqAZO1WZ7kXHIZUY6Mrws6NVmbt2cp
BM77ECyLAgMBAAECggEAA3x4j/pG99fP/AosfiPLYLMmcjPvwknxxrorFhCCZigd
50kGouKc0ZWqOCZXhtRaKZO7RcszQ66UIc18rmxYITk9K1KlPK3JoZqRb0a5n96u
ENf6ZuWOuOPCJFXxxz9q+K21m5cJrcfkPMIn8EN2cBzFMDPressJBpASWztJm6+0
g6uTBt6l9CU3ObvjyORefXSfPwkhGKNfvgy75/VSlddcDAV+wjH14JdqWdMlntHH
fMRPboYC3cvik6YsWb6qNGfjXz+Hzeba7D13y+QGYWrdfBfavbTHqkgZKas7AmyY
Tdrl1VlWD+h03Tec3DkhIxrdeA1+Wf+wmBjonmURSQKBgQDgrpsNIe8Ee/TT7VMz
4fb3GfplRv0lshPfYW5W4ULEga2Oviz32BtSPhgG6NFZwIJ+MTxQhvPwGMQuYfqR
CR3SG9O+m+kr4CLJJLxQ0RHBQ9VtP9wVOKqUiNkE9ez7mqx3/RF8oenNUPkAUFso
1O0d9p87H5xpGZ43NVupfGpL1wKBgQDQbM0rYOK+1YToh7RanFLW0MpvQcvQHjsF
qJ56yoza0f/3FNyrEy7vcwzI5m+mQLfRMLkrvljv+iavjylG2cZDr+/lK4QQRcyM
LQctBJeSXw/y2+dS7AvL5XJQkRe8hpZTpFNdVsOnzWrqEl674CrFZKo89ORIirLJ
7GJJgZTubQKBgQDF2FrGNKRREYnj9+41GHws2N5Jwjn1sJqZMCVGMbNmcD5RHJti
XxSn1e+4XdjDLKZ70oUm777sJBLUOQi4IAv3UPOiu42WSha3gjak/4Sf50iPnBUD
RtPGWb6oBJn6cBgAzIJSegzz86JfqWKsUNq/cMSD/nDvh1Rvjve5BcpgHwKBgAKi
7bF3x0Z8svKyDMD8qzuWZokjvu1CBKMcr+yDtWZrM56vf98WHgjfXrEH4S+sL+cQ
g7ce8EcQ1f5whCgmRxDCH/m5JDGEgILhau7R2Qz78Nq0l2eAHuIUY+7K9w7mcO5b
7MYIe+8adRjC5LnhqwjWLiUZP+3++yX8vH2LixO9AoGATPqMHTEaIrIh999ahqmv
OulHU1mIPsNEzbagWNwCmDJB5+MJPE76j59Gg1NMVmRQvDOnhktjCdyr7cLoSyb5
cT0XqIpKa8tyk2RAMjqM52QwttVzRnDjhqrpyM+9HsPyP7huvTlkpwLBE8GR7cP3
guigOK0SOM7v+1ceZuh/bm8=
-----END PRIVATE KEY-----
`;

function authorizationHeaders(
  overrides?: Partial<Record<string, string>>,
): Promise<Record<string, string>> {
  return createOidcToken(overrides).then((token) => ({
    authorization: `Bearer ${token}`,
  }));
}

async function createOidcToken(overrides?: Partial<Record<string, string>>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = createPrivateKey(testPrivateKeyPem);

  return new SignJWT({
    actor: "dependabot[bot]",
    event_name: "workflow_dispatch",
    ref: "refs/heads/main",
    repository: "cysp/terraform-provider-contentful",
    repository_id: "123456789",
    run_attempt: "1",
    run_id: "987654321",
    sha: "0123456789abcdef0123456789abcdef01234567",
    workflow: "update indirect dependencies",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setAudience("cyspbot")
    .setIssuer("https://token.actions.githubusercontent.com")
    .setIssuedAt(now - 10)
    .setNotBefore(now - 10)
    .setExpirationTime(now + 300)
    .setSubject("repo:cysp/terraform-provider-contentful:ref:refs/heads/main")
    .sign(privateKey);
}

describe("cyspbot worker", () => {
  it("returns minimal problem details for missing authentication", async () => {
    const response = await SELF.fetch("https://example.test/github/claims", {
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toEqual({
      status: 401,
      title: "Unauthorized",
      type: "about:blank",
    });
  });

  it("verifies caller claims without evaluating full token mint policy", async () => {
    const response = await SELF.fetch("https://example.test/github/claims", {
      headers: await authorizationHeaders({
        event_name: "pull_request",
        ref: "refs/pull/12/merge",
      }),
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      event_name: "pull_request",
      ref: "refs/pull/12/merge",
      repository: "cysp/terraform-provider-contentful",
      repository_id: "123456789",
    });
  });

  it("mints a repository-scoped installation token for allowed events", async () => {
    const response = await SELF.fetch("https://example.test/github/installations/token", {
      headers: await authorizationHeaders(),
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      expires_at: "2030-01-01T00:00:00Z",
      token: "ghs_test_token",
    });
  });

  it("rejects disallowed events", async () => {
    const response = await SELF.fetch("https://example.test/github/installations/token", {
      headers: await authorizationHeaders({
        event_name: "pull_request",
        ref: "refs/pull/15/merge",
      }),
      method: "POST",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      status: 403,
      title: "Forbidden",
      type: "about:blank",
    });
  });

  it("rejects pushes that are not on the current default branch", async () => {
    const response = await SELF.fetch("https://example.test/github/installations/token", {
      headers: await authorizationHeaders({
        event_name: "push",
        ref: "refs/heads/feature-branch",
      }),
      method: "POST",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      status: 403,
      title: "Forbidden",
      type: "about:blank",
    });
  });

  it("allows pushes on the current default branch", async () => {
    const response = await SELF.fetch("https://example.test/github/installations/token", {
      headers: await authorizationHeaders({
        event_name: "push",
        ref: "refs/heads/main",
      }),
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      expires_at: "2030-01-01T00:00:00Z",
      token: "ghs_test_token",
    });
  });
});
