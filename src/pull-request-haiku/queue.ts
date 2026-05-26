export interface PullRequestHaikuQueueMessage {
  action: string;
  deliveryId: string;
  enqueuedAt: string;
  headSha: string;
  installationId: number;
  pullRequestNumber: number;
  repositoryFullName: string;
  repositoryId: number;
}

export function parsePullRequestHaikuQueueMessage(
  body: unknown,
): PullRequestHaikuQueueMessage | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const value = body as Record<string, unknown>;
  const action = value["action"];
  const deliveryId = value["deliveryId"];
  const enqueuedAt = value["enqueuedAt"];
  const headSha = value["headSha"];
  const installationId = value["installationId"];
  const pullRequestNumber = value["pullRequestNumber"];
  const repositoryFullName = value["repositoryFullName"];
  const repositoryId = value["repositoryId"];

  if (
    typeof action !== "string" ||
    typeof deliveryId !== "string" ||
    typeof enqueuedAt !== "string" ||
    typeof headSha !== "string" ||
    typeof installationId !== "number" ||
    typeof pullRequestNumber !== "number" ||
    typeof repositoryFullName !== "string" ||
    typeof repositoryId !== "number"
  ) {
    return null;
  }

  return {
    action,
    deliveryId,
    enqueuedAt,
    headSha,
    installationId,
    pullRequestNumber,
    repositoryFullName,
    repositoryId,
  };
}
