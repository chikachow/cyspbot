import { env, exports } from "cloudflare:workers";
import { requestGitHubAppInstallationToken } from "@cyspbot/token-exchange";
import { describe, expect, it } from "vitest";

describe("cyspbot Worker entrypoint", () => {
  it("serves only the root bot page", async () => {
    const rootResponse = await exports.default.fetch("https://cyspbot.chikachow.org/");

    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    await expect(rootResponse.text()).resolves.toContain("beep, boop");

    const postResponse = await exports.default.fetch("https://cyspbot.chikachow.org/", {
      method: "POST",
    });

    expect(postResponse.status).toBe(405);
    expect(postResponse.headers.get("allow")).toBe("GET, HEAD");
    await expect(postResponse.text()).resolves.toBe("");

    const missingResponse = await exports.default.fetch("https://cyspbot.chikachow.org/robots.txt");

    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.text()).resolves.toBe("");
  });

  it("calls the WorkloadIdentityIssuer named entrypoint over RPC", async () => {
    await expect(
      requestGitHubAppInstallationToken(env, {
        resource: "https://api.github.com/repos/chikachow/cyspbot",
        scope: "contents:read",
      }),
    ).resolves.toEqual({
      accessToken: "ghs_integration_token",
      expiresIn: 300,
      scope: "contents:read",
    });
  });
});
