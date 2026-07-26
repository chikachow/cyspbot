import { describe, expect, it } from "vitest";

import {
  createInstallationAccessTokenForRepositoryName,
  resolveInstallationForRepository,
} from "../packages/github/src/app.ts";
import { testPrivateKeyPem, testRepository } from "./support/constants.ts";

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

          return Response.json({ id: 12345 });
        },
      },
    );

    expect(installation).toEqual({ id: 12345 });
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
