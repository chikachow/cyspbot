import { describe, expect, it } from "vitest";

import type {
  OidcIdTokenAuthenticationResult,
  OidcIdTokenAuthenticator,
} from "@cyspbot/oidc/id-token-authenticator";
import { authenticateOidcIdToken } from "@cyspbot/token-exchange/authentication";

type AuthenticationFailure = Extract<OidcIdTokenAuthenticationResult, { ok: false }>;

describe("OIDC authentication HTTP boundary", () => {
  it.each<[string, AuthenticationFailure, string]>([
    [
      "provider unavailability",
      {
        failure: {
          diagnostics: {
            diagnosticCode: "ERR_OIDC_PROVIDER_CONFIGURATION_FETCH_FAILED",
            providerHttpStatus: 503,
          },
          kind: "provider_unavailable",
        },
        ok: false,
      },
      "oidc_provider_failure",
    ],
    [
      "an internal failure",
      {
        failure: {
          diagnostics: {},
          kind: "internal_failure",
        },
        ok: false,
      },
      "oidc_internal_failure",
    ],
    [
      "subject-token rejection",
      {
        failure: {
          diagnostics: { diagnosticCode: "ERR_JWT_INVALID" },
          kind: "subject_token_rejected",
        },
        ok: false,
      },
      "invalid_token",
    ],
  ])("maps %s", async (_description, failure, reason) => {
    const request = new Request("https://cyspbot.example/token");
    const authenticator: OidcIdTokenAuthenticator = {
      authenticateIdToken: async () => failure,
    };

    await expect(authenticateOidcIdToken("token", request, authenticator)).resolves.toMatchObject({
      ...failure.failure.diagnostics,
      ok: false,
      reason,
    });
  });
});
