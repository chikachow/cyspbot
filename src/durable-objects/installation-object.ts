import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env.ts";
import { recordInstallationReconciliationSignal } from "../storage/installation-reconciliation.ts";

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

    await recordInstallationReconciliationSignal(this.env, {
      installationId: request.installationId,
      requestedAt: new Date().toISOString(),
    });

    return {
      ok: true,
    };
  }
}
