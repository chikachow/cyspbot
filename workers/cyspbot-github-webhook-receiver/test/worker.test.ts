import { describe, expect, it, vi } from "vitest";

import { fetchGitHubWebhookReceiver } from "./support/worker.ts";

describe("GitHub webhook receiver routing", () => {
  it.each([
    ["GET", "/github/webhooks", 405, "POST"],
    ["PUT", "/github/webhooks", 405, "POST"],
    ["DELETE", "/github/webhooks", 405, "POST"],
    ["OPTIONS", "/github/webhooks", 405, "POST"],
    ["POST", "/absent", 404, null],
  ] as const)(
    "handles %s %s before webhook authentication",
    async (method, path, status, allow) => {
      const get = vi.fn();
      const send = vi.fn();
      const response = await fetchGitHubWebhookReceiver(
        new Request(`https://example.test${path}`, { method }),
        {
          GITHUB_APP_ID: "000000",
          GITHUB_WEBHOOK_JOBS: { send },
          GITHUB_WEBHOOK_SECRET: { get },
        },
      );

      expect(response.status).toBe(status);
      expect(response.headers.get("allow")).toBe(allow);
      expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
      await expect(response.json()).resolves.toEqual({
        type: "about:blank",
        title: status === 405 ? "Method Not Allowed" : "Not Found",
        status,
      });
      expect(get).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );
});
