import {
  createInstallationToken,
  getRepository,
  type GitHubRepository,
  resolveInstallationForRepository,
} from "@cyspbot/github/app";
import { GitHubApiError, type GitHubApiDependencies } from "@cyspbot/github/http";
import type { GitHubActionsPrincipal } from "@cyspbot/github-actions-oidc/principals";
import type { AuthenticatedContext } from "../authentication.ts";
import {
  evaluateTokenPolicyPreflight,
  evaluateTokenPolicy,
  type TokenPolicyAllowDecision,
  type TokenPolicyDecision,
} from "./token-policy.ts";

export type InstallationTokenIssuanceDependencies = GitHubApiDependencies;

type InstallationTokenIssuanceResult =
  | { expiresAt: string; ok: true; token: string }
  | { ok: false; status: number };

class TokenPolicyDeniedError extends Error {
  public readonly policyDecision: TokenPolicyDecision | undefined;
  public readonly repository: GitHubRepository | undefined;

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

async function authorizeInstallationTokenIssuance(
  env: TokenExchangeBindings,
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

export async function issueInstallationTokenForContext(
  env: TokenExchangeBindings,
  authenticationContext: AuthenticatedContext,
  dependencies: InstallationTokenIssuanceDependencies,
): Promise<InstallationTokenIssuanceResult> {
  const { principal } = authenticationContext;
  let installationId: number | undefined;

  try {
    const preflightDecision = evaluateTokenPolicyPreflight(principal);

    if (preflightDecision.decision !== "allow") {
      throw new TokenPolicyDeniedError(
        "Token Policy denied Installation Token Issuance before GitHub API calls",
        preflightDecision,
      );
    }

    const installation = await resolveInstallationForRepository(
      env,
      principal.repository,
      dependencies,
    );
    installationId = installation.id;

    const authorization = await authorizeInstallationTokenIssuance(
      env,
      installation.id,
      principal,
      dependencies,
    );
    const token = await createInstallationToken(
      env,
      installation.id,
      principal.repositoryId,
      authorization.policyDecision.permissions,
      dependencies,
    );

    console.info("Installation Token Issuance succeeded", {
      ...authenticatedContextLogFields(authenticationContext),
      expires_at: token.expiresAt,
      installation_id: installation.id,
      permissions: authorization.policyDecision.permissions,
      policy_reasons: authorization.policyDecision.reasons,
    });

    return {
      expiresAt: token.expiresAt,
      ok: true,
      token: token.token,
    };
  } catch (error) {
    const status = statusForInstallationTokenIssuanceError(error);

    console.error("Installation Token Issuance failed", {
      ...authenticatedContextLogFields(authenticationContext),
      error_message: logMessageForInstallationTokenIssuanceError(error),
      error_name: error instanceof Error ? error.name : typeof error,
      error_status: error instanceof GitHubApiError ? error.status : undefined,
      installation_id: installationId,
      policy_reasons:
        error instanceof TokenPolicyDeniedError ? error.policyDecision?.reasons : undefined,
    });

    return { ok: false, status };
  }
}

function statusForInstallationTokenIssuanceError(error: unknown): number {
  if (error instanceof TokenPolicyDeniedError) {
    return 403;
  }

  if (error instanceof Response) {
    return error.status;
  }

  if (error instanceof GitHubApiError) {
    if (error.status === 400) {
      return 500;
    }

    if (error.status === 401 || error.status === 403 || error.status === 404) {
      return 403;
    }

    if (error.status >= 500) {
      return 502;
    }
  }

  return 500;
}

function logMessageForInstallationTokenIssuanceError(error: unknown): string {
  if (error instanceof GitHubApiError || error instanceof TokenPolicyDeniedError) {
    return error.message;
  }

  return "unexpected Installation Token Issuance error";
}

function authenticatedContextLogFields(
  authenticationContext: AuthenticatedContext,
): Record<string, unknown> {
  const { principal } = authenticationContext;

  return {
    actor: principal.actor,
    event_name: principal.eventName,
    issuer: authenticationContext.issuer,
    job_workflow_ref: principal.jobWorkflowRef,
    ref: principal.ref,
    ref_type: principal.refType,
    repository: principal.repository,
    repository_id: principal.repositoryId,
    repository_owner_id: principal.repositoryOwnerId,
    repository_visibility: principal.repositoryVisibility,
    resolved_key_id: authenticationContext.resolvedKeyId,
    run_attempt: principal.runAttempt,
    run_id: principal.runId,
    sha: principal.sha,
    sub: principal.rawSubject,
    subject_kind: principal.subject.kind,
    workflow: principal.workflow,
    workflow_ref: principal.workflowRef,
  };
}
