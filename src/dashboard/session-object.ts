import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env.ts";

export interface DashboardRepositoryAccessEntry {
  fullName: string;
  githubRepoId: string;
  installationId: number;
  name: string;
  ownerLogin: string;
  permissions: Record<string, boolean>;
  private: boolean;
}

export interface DashboardSessionState {
  accessTokenCiphertext: string;
  accessTokenExpiresAt: string | null;
  githubLogin: string;
  githubUserId: string;
  refreshTokenCiphertext: string | null;
  refreshTokenExpiresAt: string | null;
  repositoryAccessCacheExpiresAt: string | null;
}

export interface StoredDashboardSession {
  repositories: DashboardRepositoryAccessEntry[];
  session: DashboardSessionState | null;
}

export class DashboardSessionObject extends DurableObject<Env> {
  public async clearSession(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  public async getSession(): Promise<StoredDashboardSession> {
    const session =
      ((await this.ctx.storage.get("session")) as DashboardSessionState | undefined) ?? null;
    const repositories =
      ((await this.ctx.storage.get("repositories")) as
        | DashboardRepositoryAccessEntry[]
        | undefined) ?? [];

    return {
      repositories,
      session,
    };
  }

  public async replaceRepositoryAccessCache(request: {
    expiresAt: string;
    repositories: DashboardRepositoryAccessEntry[];
  }): Promise<void> {
    const existing =
      ((await this.ctx.storage.get("session")) as DashboardSessionState | undefined) ?? null;

    if (existing === null) {
      return;
    }

    await this.ctx.storage.put("session", {
      ...existing,
      repositoryAccessCacheExpiresAt: request.expiresAt,
    } satisfies DashboardSessionState);
    await this.ctx.storage.put("repositories", request.repositories);
  }

  public async storeSession(request: DashboardSessionState): Promise<void> {
    await this.ctx.storage.put("session", request);
    await this.ctx.storage.put("repositories", []);
  }
}
