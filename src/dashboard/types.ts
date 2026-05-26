export interface DashboardSession {
  accessToken: string;
  accessTokenExpiresAt: string | null;
  absoluteExpiresAt: string;
  githubLoginDisplay: string;
  githubUserId: string;
  id: number;
  idleExpiresAt: string;
}

export interface DashboardRepositoryListItem {
  archivedAt: string | null;
  fullNameDisplay: string;
  installationId: number;
  lastInstallationTokenIssuanceAt: string | null;
  lastOutcome: string | null;
  pullRequestHaikuEnabled?: boolean;
  repositoryId: number;
  repositoryVisibility: string;
}

export interface DashboardRepository {
  archivedAt: string | null;
  fullNameDisplay: string;
  fullNameNormalized: string;
  repositoryId: number;
  repositoryVisibility: string;
}

export interface DashboardAuditEntry {
  actor: string | null;
  auditState: "finalization_failed" | "finalized" | "pending";
  eventName: string;
  expiresAt: string | null;
  fullNameDisplay: string;
  id: number;
  installationId: number | null;
  outcome: "denied" | "internal_error" | "issued" | "upstream_error" | null;
  permissions: Record<string, string>;
  reasons: string[];
  ref: string | null;
  requestedAt: string;
  workflowRef: string | null;
}
