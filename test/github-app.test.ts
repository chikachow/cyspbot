import { describe, expect, it } from "vitest";

import {
  createInstallationAccessTokenForRepositoryName,
  resolveInstallationForRepository,
} from "../packages/github/src/app.ts";
import { testRepository } from "./support/constants.ts";
import { githubInstallationResponse } from "./support/github-api.ts";
import { testPrivateKeyPem } from "./support/rsa-test-key-pair.ts";

describe("GitHub App authentication", () => {
  it("reads the app private key from Cloudflare Secrets Store when bound", async () => {
    const secretStoreBinding = {
      get: async () => testPrivateKeyPem,
    };

    const installation = await resolveInstallationForRepository(
      {
        GITHUB_API_BASE_URL: "https://api.github.test",
        GITHUB_APP_ID: "2419473",
        GITHUB_APP_PRIVATE_KEY: secretStoreBinding,
      },
      testRepository,
      {
        fetch: async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
          expect(input).toBeInstanceOf(URL);
          if (!(input instanceof URL)) {
            throw new Error("expected GitHub API request URL");
          }

          expect(input.href).toBe(`https://api.github.test/repos/${testRepository}/installation`);

          const headers = new Headers(init?.headers);
          expect(headers.get("accept")).toBe("application/vnd.github+json");
          expect(headers.get("user-agent")).toBe("cyspbot");
          expect(headers.get("x-github-api-version")).toBe("2022-11-28");
          expect(headers.get("authorization")).toMatch(/^Bearer /u);

          return githubInstallationResponse("fixture-owner", 12345);
        },
      },
    );

    expect(installation).toEqual({ id: 12345 });
  });

  it("matches the installation account owner case-insensitively", async () => {
    await expect(
      resolveTestInstallation(githubInstallationResponse("FIXTURE-OWNER", 12345)),
    ).resolves.toEqual({ id: 12345 });
  });

  it("rejects an installation account for a different owner", async () => {
    await expect(
      resolveTestInstallation(githubInstallationResponse("transferred-owner", 12345)),
    ).rejects.toMatchObject({
      message: "invalid installation response",
      status: 502,
    });
  });

  it.each([
    { response: "not an object", scenario: "a scalar response" },
    { response: null, scenario: "a null response" },
    { response: [], scenario: "an array response" },
    { response: { id: 12345 }, scenario: "a response without an account" },
    {
      response: { account: { login: "fixture-owner" } },
      scenario: "a response without an installation ID",
    },
    {
      response: { account: null, id: 12345 },
      scenario: "a response with a null account",
    },
    {
      response: { account: [], id: 12345 },
      scenario: "a response with an array account",
    },
    {
      response: { account: {}, id: 12345 },
      scenario: "an account without a login",
    },
    {
      response: { account: { login: 12345 }, id: 12345 },
      scenario: "an account with a non-string login",
    },
    {
      response: { account: { login: "fixture-owner" }, id: "12345" },
      scenario: "a response with a non-numeric installation ID",
    },
  ])("rejects $scenario", async ({ response }) => {
    await expect(resolveTestInstallation(Response.json(response))).rejects.toMatchObject({
      message: "invalid installation response",
      status: 502,
    });
  });

  it("rejects a malformed installation access token response", async () => {
    await expect(
      createInstallationAccessTokenForRepositoryName(
        {
          GITHUB_APP_ID: "2419473",
          GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
        },
        12345,
        "fixture-repository",
        { contents: "read" },
        {
          fetch: async () =>
            Response.json({
              expires_at: "2030-01-01T00:00:00Z",
              permissions: { contents: "read" },
            }),
        },
      ),
    ).rejects.toMatchObject({
      message: "invalid installation access token response",
      status: 502,
    });
  });
});

function resolveTestInstallation(response: Response) {
  return resolveInstallationForRepository(
    {
      GITHUB_APP_ID: "2419473",
      GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
    },
    testRepository,
    { fetch: async () => response },
  );
}
