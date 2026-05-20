import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env.ts";
import {
  loadIssuerRegistrationByIssuer,
  OidcConfigurationError,
} from "../oidc/issuer-registrations.ts";
import type { VerifyOidcTokenResult } from "../oidc/principals.ts";
import { verifyOidcToken } from "../oidc/verify-oidc-token.ts";
import {
  emptyVerifierState,
  hydrateVerifierState,
  persistVerifierState,
  registrationFingerprint,
  type PersistedVerifierState,
  type VerifierState,
} from "../oidc/verifier-state.ts";

const verifierStateStorageKey = "verifier_state";

export class OidcIssuerVerifierObject extends DurableObject<Env> {
  private readonly clock = {
    now: () => Date.now(),
  };
  private readonly fetchImpl: typeof fetch = fetch;
  private readonly importedKeys = new Map<string, Promise<CryptoKey>>();
  private state: VerifierState | null = null;

  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      await this.initializeState();
    });
  }

  public async verifyOidcToken(token: string, issuer: string): Promise<VerifyOidcTokenResult> {
    const registration = await loadRegistration(this.env, issuer);

    if (registration instanceof Error) {
      return {
        issuer,
        ok: false,
        reason: "configuration_error",
      };
    }

    if (this.state === null) {
      this.state = emptyVerifierState(registrationFingerprint(registration));
    } else if (this.state.fingerprint !== registrationFingerprint(registration)) {
      this.state = hydrateVerifierState(persistVerifierState(this.state), registration);
    }

    const verification = await verifyOidcToken(
      token,
      registration,
      this.state,
      this.clock,
      this.fetchImpl,
      this.importedKeys,
    );

    this.state = verification.nextState;
    await this.ctx.storage.put(verifierStateStorageKey, persistVerifierState(this.state));

    return verification.result;
  }

  private async initializeState(): Promise<void> {
    const persistedState = (await this.ctx.storage.get(verifierStateStorageKey)) as
      | PersistedVerifierState
      | undefined;

    if (persistedState === undefined) {
      this.state = null;
      return;
    }

    this.state = {
      backoff: persistedState.backoff,
      fingerprint: persistedState.fingerprint,
      snapshot: persistedState.snapshot,
    };
  }
}

async function loadRegistration(env: Env, issuer: string) {
  try {
    const registration = await loadIssuerRegistrationByIssuer(env, issuer);

    if (registration === null) {
      return new OidcConfigurationError(`missing issuer registration for ${issuer}`);
    }

    return registration;
  } catch (error) {
    console.error("OIDC issuer registration load failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      issuer,
    });

    return error instanceof Error ? error : new Error(String(error));
  }
}
