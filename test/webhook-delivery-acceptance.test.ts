import { describe, expect, it } from "vitest";

import {
  acceptGitHubWebhookDelivery,
  type WebhookDeliveryAcceptanceDependencies,
} from "../src/webhook/delivery-acceptance.ts";
import { githubWebhookHeaders } from "./support/webhook.ts";
import { testEnv } from "./support/worker.ts";

describe("webhook delivery acceptance", () => {
  it("accepts an opted-in pull request delivery through injected application services", async () => {
    const enqueued: unknown[] = [];
    const recorded: unknown[] = [];
    const reconciledInstallations: number[] = [];
    const dependencies: WebhookDeliveryAcceptanceDependencies = {
      enqueuePullRequestHaikuMessage: async (_env, message) => {
        enqueued.push(message);
      },
      now: () => new Date("2026-05-24T00:00:00.000Z"),
      pullRequestHaikuFeatureEnabled: async (_env, input) => {
        expect(input).toEqual({
          installationId: 67890,
          pullRequestNumber: 12,
          repositoryFullName: "cysp/terraform-provider-contentful",
          repositoryId: 123456789,
        });
        return true;
      },
      pullRequestHaikuRepositoryOptedIn: async (_env, repositoryId) => {
        expect(repositoryId).toBe(123456789);
        return true;
      },
      reconcileInstallation: async (_env, installationId) => {
        reconciledInstallations.push(installationId);
        return { ok: true };
      },
      recordPullRequestHaikuQueued: async (_env, input) => {
        recorded.push(input);
      },
    };
    const body = JSON.stringify({
      action: "synchronize",
      installation: {
        id: 67890,
      },
      pull_request: {
        head: {
          sha: "abc123def456abc123def456abc123def456abcd",
        },
        number: 12,
      },
      repository: {
        full_name: "cysp/terraform-provider-contentful",
        id: 123456789,
      },
    });

    const result = await acceptGitHubWebhookDelivery(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(
          body,
          "test-webhook-secret",
          "pull_request",
          "delivery-pr-opted-in",
        ),
        method: "POST",
      }),
      testEnv,
      dependencies,
    );

    expect(result).toEqual({
      body: { accepted: true },
      kind: "accepted",
      status: 202,
    });
    expect(reconciledInstallations).toEqual([67890]);
    expect(recorded).toEqual([
      {
        action: "synchronize",
        deliveryId: "delivery-pr-opted-in",
        headSha: "abc123def456abc123def456abc123def456abcd",
        installationId: 67890,
        pullRequestNumber: 12,
        queuedAt: "2026-05-24T00:00:00.000Z",
        repositoryFullName: "cysp/terraform-provider-contentful",
        repositoryId: 123456789,
      },
    ]);
    expect(enqueued).toEqual([
      {
        action: "synchronize",
        deliveryId: "delivery-pr-opted-in",
        enqueuedAt: "2026-05-24T00:00:00.000Z",
        headSha: "abc123def456abc123def456abc123def456abcd",
        installationId: 67890,
        pullRequestNumber: 12,
        repositoryFullName: "cysp/terraform-provider-contentful",
        repositoryId: 123456789,
      },
    ]);
  });
});
