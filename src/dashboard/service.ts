import type { Env } from "../env.ts";
import type { GitHubApiDependencies } from "../github/http.ts";
import {
  listGitHubUserInstallationRepositories,
  listGitHubUserInstallations,
  type GitHubUserRepositoryAccess,
} from "../github/user.ts";
import { listRepositoryAuditSummaries } from "../storage/audit-log.ts";
import {
  listPullRequestHaikuRepositoryOptIns,
  setPullRequestHaikuRepositoryOptIn,
} from "../storage/pull-request-haiku.ts";
import type {
  DashboardRepository,
  DashboardRepositoryListItem,
  DashboardSession,
} from "./types.ts";

export async function listDashboardPullRequestHaikuModel(
  env: Env,
  session: DashboardSession,
  dependencies: GitHubApiDependencies,
  now: string,
): Promise<DashboardRepositoryListItem[] | null> {
  const repositories = await listAccessibleDashboardRepositories(env, session, dependencies, now);
  const administeredRepositories = repositories.filter((repository) => repository.canAdminister);

  if (administeredRepositories.length === 0) {
    return null;
  }

  const optIns = await listPullRequestHaikuRepositoryOptIns(env);

  return administeredRepositories.map((repository) => ({
    ...repository,
    pullRequestHaikuEnabled: optIns.has(repository.repositoryId),
  }));
}

export async function setDashboardPullRequestHaikuOptIn(
  env: Env,
  input: {
    enabled: boolean;
    repositoryId: number;
    session: DashboardSession;
  },
  dependencies: GitHubApiDependencies,
): Promise<"forbidden" | "not_found" | "ok"> {
  const repositories = await listAccessibleRepositoryAccesses(env, input.session, dependencies);
  const administeredRepositories = repositories.filter(
    (repository) => repository.permissions.admin,
  );

  if (administeredRepositories.length === 0) {
    return "forbidden";
  }

  const repository = repositories.find(
    (candidate) =>
      candidate.permissions.admin &&
      parseRepositoryId(candidate.githubRepoId) === input.repositoryId,
  );

  if (repository === undefined) {
    return "not_found";
  }

  await setPullRequestHaikuRepositoryOptIn(env, {
    enabled: input.enabled,
    repositoryFullName: repository.fullName,
    repositoryId: input.repositoryId,
  });

  return "ok";
}

export async function listAccessibleDashboardRepositories(
  env: Env,
  session: DashboardSession,
  dependencies: GitHubApiDependencies,
  now: string,
): Promise<DashboardRepositoryListItem[]> {
  const repositoryAccesses = await listAccessibleRepositoryAccesses(env, session, dependencies);

  const auditSummaries = await listRepositoryAuditSummaries(
    env,
    repositoryAccesses.map((repository) => parseRepositoryId(repository.githubRepoId)),
  );

  return repositoryAccesses
    .map((repository) => {
      const repositoryId = parseRepositoryId(repository.githubRepoId);
      const auditSummary = auditSummaries.get(repositoryId);

      return {
        archivedAt: repository.archived ? now : null,
        canAdminister: repository.permissions.admin,
        fullNameDisplay: repository.fullName,
        installationId: repository.installationId,
        lastInstallationTokenIssuanceAt: auditSummary?.lastInstallationTokenIssuanceAt ?? null,
        lastOutcome: auditSummary?.lastOutcome ?? null,
        repositoryId,
        repositoryVisibility: repository.private ? "private" : "public",
      };
    })
    .sort(compareDashboardRepositoryListItems);
}

export async function getAccessibleDashboardRepositoryByFullName(
  env: Env,
  session: DashboardSession,
  owner: string,
  name: string,
  dependencies: GitHubApiDependencies,
  now: string,
): Promise<DashboardRepository | null> {
  const fullNameNormalized = normalizeRepositoryFullName(`${owner}/${name}`);
  const visibleRepository = await findAccessibleRepositoryAccessByFullName(
    env,
    session,
    dependencies,
    fullNameNormalized,
  );

  if (visibleRepository === null) {
    return null;
  }

  const repositoryId = parseRepositoryId(visibleRepository.githubRepoId);

  return {
    archivedAt: visibleRepository.archived ? now : null,
    canAdminister: visibleRepository.permissions.admin,
    fullNameDisplay: visibleRepository.fullName,
    fullNameNormalized,
    repositoryId,
    repositoryVisibility: visibleRepository.private ? "private" : "public",
  };
}

async function listAccessibleRepositoryAccesses(
  env: Env,
  session: DashboardSession,
  dependencies: GitHubApiDependencies,
): Promise<GitHubUserRepositoryAccess[]> {
  const installations = await listGitHubUserInstallations(env, session.accessToken, dependencies);
  const repositoryAccesses: GitHubUserRepositoryAccess[] = [];

  for (const installation of installations) {
    const repositories = await listGitHubUserInstallationRepositories(
      env,
      session.accessToken,
      installation.id,
      dependencies,
    );
    repositoryAccesses.push(...repositories);
  }

  return repositoryAccesses;
}

async function findAccessibleRepositoryAccessByFullName(
  env: Env,
  session: DashboardSession,
  dependencies: GitHubApiDependencies,
  fullNameNormalized: string,
): Promise<GitHubUserRepositoryAccess | null> {
  const installations = await listGitHubUserInstallations(env, session.accessToken, dependencies);

  for (const installation of installations) {
    const repositories = await listGitHubUserInstallationRepositories(
      env,
      session.accessToken,
      installation.id,
      dependencies,
    );
    const repository = repositories.find(
      (candidate) => normalizeRepositoryFullName(candidate.fullName) === fullNameNormalized,
    );

    if (repository !== undefined) {
      return repository;
    }
  }

  return null;
}

function compareDashboardRepositoryListItems(
  left: DashboardRepositoryListItem,
  right: DashboardRepositoryListItem,
): number {
  const leftArchived = left.archivedAt === null ? 0 : 1;
  const rightArchived = right.archivedAt === null ? 0 : 1;

  if (leftArchived !== rightArchived) {
    return leftArchived - rightArchived;
  }

  const leftLastIssuance = left.lastInstallationTokenIssuanceAt ?? "";
  const rightLastIssuance = right.lastInstallationTokenIssuanceAt ?? "";

  if (leftLastIssuance !== rightLastIssuance) {
    return rightLastIssuance.localeCompare(leftLastIssuance);
  }

  const fullNameComparison = left.fullNameDisplay.localeCompare(right.fullNameDisplay);

  if (fullNameComparison !== 0) {
    return fullNameComparison;
  }

  return left.installationId - right.installationId;
}

function normalizeRepositoryFullName(value: string): string {
  return value.trim().toLowerCase();
}

function parseRepositoryId(value: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("invalid GitHub repository id");
  }

  return parsed;
}
