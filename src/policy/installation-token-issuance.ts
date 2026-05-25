import type { Env } from "../env.ts";
import {
  createInstallationToken,
  GitHubApiError,
  getRepository,
  type GitHubApiDependencies,
  type GitHubRepository,
  resolveInstallationForRepository,
} from "../github/api.ts";
import type { AuthenticatedContext, GitHubActionsPrincipal } from "../oidc/principals.ts";
import {
  createAuditIntent,
  finalizeAuditEntry,
  markAuditFinalizationFailed,
} from "../storage/audit-log.ts";
import {
  evaluateTokenPolicy,
  type TokenPolicyAllowDecision,
  type TokenPolicyDecision,
} from "./token-policy.ts";

export interface InstallationTokenIssuanceDependencies extends GitHubApiDependencies {
  now(): Date;
}

export interface InstallationTokenIssuanceSuccess {
  expiresAt: string;
  ok: true;
  token: string;
}

export type InstallationTokenIssuanceResult =
  | InstallationTokenIssuanceSuccess
  | { ok: false; status: number };

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

export async function issueInstallationTokenForContext(
  env: Env,
  authenticationContext: AuthenticatedContext,
  dependencies: InstallationTokenIssuanceDependencies,
): Promise<InstallationTokenIssuanceResult> {
  const { issuerRegistration, principal, resolvedKeyId } = authenticationContext;
  const requestedAt = dependencies.now().toISOString();
  let auditIntent;
  let installationId: number | undefined;

  try {
    auditIntent = await createAuditIntent(
      env,
      principal,
      issuerRegistration.issuer,
      resolvedKeyId,
      requestedAt,
    );
  } catch (error) {
    console.error("Installation Token Issuance audit intent write failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      eventName: principal.eventName,
      repository: principal.repository,
      repositoryId: principal.repositoryId,
    });

    return { ok: false, status: 500 };
  }

  try {
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

    await finalizeAuditEntry(env, {
      auditEntryId: auditIntent.id,
      expiresAt: token.expiresAt,
      finalizedAt: dependencies.now().toISOString(),
      installationId: installation.id,
      outcome: "issued",
      permissions: token.permissions,
    });

    return {
      expiresAt: token.expiresAt,
      ok: true,
      token: token.token,
    };
  } catch (error) {
    const status = statusForInstallationTokenIssuanceError(error);
    const outcome = outcomeForInstallationTokenIssuanceError(error);
    const reasons = reasonsForInstallationTokenIssuanceError(error);

    console.error("Installation Token Issuance failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : typeof error,
      errorStatus: error instanceof GitHubApiError ? error.status : undefined,
      eventName: principal.eventName,
      installationId,
      outcome,
      ref: principal.ref,
      repository: principal.repository,
      repositoryId: principal.repositoryId,
    });

    try {
      await finalizeAuditEntry(env, {
        auditEntryId: auditIntent.id,
        finalizedAt: dependencies.now().toISOString(),
        installationId,
        outcome,
        reasons,
      });
    } catch (finalizationError) {
      console.error("Installation Token Issuance audit finalization failed", {
        auditEntryId: auditIntent.id,
        errorMessage:
          finalizationError instanceof Error
            ? finalizationError.message
            : String(finalizationError),
      });

      try {
        await markAuditFinalizationFailed(env, auditIntent.id, dependencies.now().toISOString());
      } catch {
        // The pending audit intent remains the durable gap record.
      }

      return { ok: false, status: 500 };
    }

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

function outcomeForInstallationTokenIssuanceError(
  error: unknown,
): "denied" | "internal_error" | "upstream_error" {
  if (error instanceof TokenPolicyDeniedError) {
    return "denied";
  }

  if (error instanceof GitHubApiError) {
    return error.status >= 500 ? "upstream_error" : "denied";
  }

  return "internal_error";
}

function reasonsForInstallationTokenIssuanceError(error: unknown): string[] {
  if (error instanceof TokenPolicyDeniedError) {
    return error.policyDecision?.reasons.map(mapPolicyReason) ?? [];
  }

  if (error instanceof GitHubApiError) {
    if (error.status === 404) {
      return ["github_installation_not_found"];
    }

    if (error.status === 429) {
      return ["github_upstream_rate_limited"];
    }

    if (error.status >= 500) {
      return ["github_upstream_unavailable"];
    }

    return ["github_upstream_unexpected_response"];
  }

  return ["internal_unexpected_error"];
}

function mapPolicyReason(reason: string): string {
  const mapped: Record<string, string> = {
    event_not_allowed: "policy_event_denied",
    ref_mismatch: "policy_ref_denied",
    ref_type_mismatch: "policy_ref_type_denied",
    repository_id_mismatch: "policy_repository_id_mismatch",
    repository_mismatch: "policy_repository_name_mismatch",
    repository_owner_id_mismatch: "policy_repository_owner_id_mismatch",
    repository_visibility_mismatch: "policy_repository_visibility_mismatch",
    subject_context_kind_mismatch: "policy_subject_mismatch",
    subject_context_not_allowed: "policy_subject_mismatch",
    subject_context_value_mismatch: "policy_subject_mismatch",
    subject_repository_mismatch: "policy_subject_mismatch",
  };

  return mapped[reason] ?? "internal_unexpected_error";
}
