import type { Env } from "../env.ts";

const pullRequestHaikuFeatureFlagKey = "pull-request-haiku";

export interface PullRequestHaikuFeatureFlagContext {
  installationId: number;
  pullRequestNumber: number;
  repositoryFullName: string;
  repositoryId: number;
}

export async function pullRequestHaikuFeatureEnabled(
  env: Env,
  context: PullRequestHaikuFeatureFlagContext,
): Promise<boolean> {
  if (env.FLAGS === undefined) {
    return true;
  }

  return env.FLAGS.getBooleanValue(pullRequestHaikuFeatureFlagKey, true, {
    installationId: context.installationId,
    pullRequestNumber: context.pullRequestNumber,
    repositoryFullName: context.repositoryFullName,
    repositoryId: context.repositoryId,
  });
}
