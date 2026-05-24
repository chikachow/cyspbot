import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env.ts";

export interface SignalInstallationReconciliationRequest {
  installationId: number;
  signalSource: "manual" | "retry" | "webhook";
}

export interface SignalInstallationReconciliationFailure {
  ok: false;
  status: number;
}

export interface SignalInstallationReconciliationSuccess {
  ok: true;
}

export type SignalInstallationReconciliationResult =
  | SignalInstallationReconciliationFailure
  | SignalInstallationReconciliationSuccess;

interface InstallationCoordinatorState {
  currentRunId?: number;
  currentRunToken?: string;
  lastSignalAt?: string;
  reconcileRequested: boolean;
  reconcileRunning: boolean;
}

const coordinatorStateKey = "installation_coordinator_state";

export class GitHubInstallationObject extends DurableObject<Env> {
  public async signalInstallationReconciliation(
    request: SignalInstallationReconciliationRequest,
  ): Promise<SignalInstallationReconciliationResult> {
    if (!Number.isInteger(request.installationId) || request.installationId <= 0) {
      return {
        ok: false,
        status: 400,
      };
    }

    const now = new Date().toISOString();
    const state = await this.readState();

    await this.ctx.storage.put(coordinatorStateKey, {
      ...state,
      lastSignalAt: now,
      reconcileRequested: true,
    } satisfies InstallationCoordinatorState);

    await this.env.DB.batch([
      this.env.DB.prepare(
        `
          INSERT INTO github_app_installations (
            installation_id,
            repository_selection,
            created_at,
            updated_at
          ) VALUES (?, 'unknown', ?, ?)
          ON CONFLICT(installation_id) DO UPDATE SET
            updated_at = excluded.updated_at
        `,
      ).bind(request.installationId, now, now),
      this.env.DB.prepare(
        `
          INSERT INTO installation_reconciliation_states (
            installation_id,
            reconciliation_state,
            reconciliation_requested,
            last_requested_at,
            updated_at
          ) VALUES (?, 'pending', 1, ?, ?)
          ON CONFLICT(installation_id) DO UPDATE SET
            reconciliation_requested = 1,
            last_requested_at = excluded.last_requested_at,
            reconciliation_state = CASE
              WHEN reconciliation_state = 'running' THEN reconciliation_state
              ELSE 'pending'
            END,
            updated_at = excluded.updated_at
        `,
      ).bind(request.installationId, now, now),
    ]);

    return {
      ok: true,
    };
  }

  private async readState(): Promise<InstallationCoordinatorState> {
    const state = (await this.ctx.storage.get(coordinatorStateKey)) as
      | InstallationCoordinatorState
      | undefined;

    return (
      state ?? {
        reconcileRequested: false,
        reconcileRunning: false,
      }
    );
  }
}
