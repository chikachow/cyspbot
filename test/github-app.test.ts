import { describe, expect, it } from "vitest";

import {
  createInstallationToken,
  resolveInstallationForRepository,
} from "../packages/github/src/app.ts";
import { GitHubApiError } from "../packages/github/src/http.ts";
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

  it("rejects repository ids that are not complete decimal strings", async () => {
    await expect(
      createInstallationToken(
        {
          GITHUB_APP_ID: "2419473",
          GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
        },
        12345,
        "123abc",
        { contents: "write" },
        {
          fetch: async () => {
            throw new Error("GitHub API should not be called for an invalid repository id");
          },
        },
      ),
    ).rejects.toMatchObject({
      message: "invalid repository id",
      status: 400,
    } satisfies Pick<GitHubApiError, "message" | "status">);
  });
});
