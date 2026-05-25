import type { Env } from "../env.ts";
import {
  createInstallationToken,
  getRepository,
  type GitHubApiDependencies,
  type GitHubRepository,
} from "../github/api.ts";
import type { GitHubActionsPrincipal } from "../oidc/principals.ts";
import {
  evaluateTokenPolicy,
  type TokenPolicyAllowDecision,
  type TokenPolicyDecision,
} from "./token-policy.ts";

export class TokenPolicyDeniedError extends Error {
  public readonly policyDecision?: TokenPolicyDecision;
  public readonly repository?: GitHubRepository;

  public constructor(
    message: string,
    policyDecision?: TokenPolicyDecision,
    repository?: GitHubRepository,
  ) {
    super(message);
    this.policyDecision = policyDecision;
    this.repository = repository;
  }
}

export async function authorizeInstallationTokenIssuance(
  env: Env,
  installationId: number,
  caller: GitHubActionsPrincipal,
  dependencies: GitHubApiDependencies,
): Promise<{ policyDecision: TokenPolicyAllowDecision; repository: GitHubRepository }> {
  const metadataToken = await createInstallationToken(
    env,
    installationId,
    caller.repositoryId,
    { metadata: "read" },
    dependencies,
  );
  const repository = await getRepository(env, caller.repository, metadataToken.token, dependencies);
  const policyDecision = evaluateTokenPolicy(caller, repository);

  if (policyDecision.decision !== "allow") {
    throw new TokenPolicyDeniedError(
      "Token Policy denied Installation Token Issuance",
      policyDecision,
      repository,
    );
  }

  return { policyDecision, repository };
}
