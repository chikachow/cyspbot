import { describe, expect, it } from "vitest";

import { createFlyOidcProviderRegistration } from "../packages/oidc-provider-fly/src/provider-registration.ts";
import {
  createGitHubRepositoryResource,
  type InstallationAccessTokenRequest,
} from "@cyspbot/token-exchange/installation-access-token-request";
import { createTokenExchangeOidcIdTokenAuthenticator } from "@cyspbot/token-exchange/oidc-authentication";
import {
  claimEquals,
  compileTokenIssuancePolicy,
  githubRepository,
  oidcSubjectTokenConstraint,
  tokenIssuancePolicyPermits,
} from "@cyspbot/token-exchange/policy/token-issuance-policy";
import { fetchOidcRemoteDocumentResponseTestDouble } from "./support/oidc.ts";
import { createOidcToken } from "./support/oidc-token.ts";
import { testPrivateKeyPem } from "./support/rsa-test-key-pair.ts";

describe("OIDC ID Token authentication configuration", () => {
  it("rejects duplicate explicitly supplied issuer registrations", () => {
    const registration = createFlyOidcProviderRegistration("example-org");

    expect(() =>
      createTokenExchangeOidcIdTokenAuthenticator([registration, registration], {
        fetch: fetchOidcRemoteDocumentResponseTestDouble,
        now: () => new Date(),
      }),
    ).toThrow("duplicate OIDC Provider Registration issuer");
  });

  it("authenticates noncanonical Fly Claim relationships while policy selects material Claims", async () => {
    const registration = createFlyOidcProviderRegistration("example-org");
    const authenticator = createTokenExchangeOidcIdTokenAuthenticator([registration], {
      fetch: fetchOidcRemoteDocumentResponseTestDouble,
      now: () => new Date(),
    });
    const token = await createOidcToken(
      testPrivateKeyPem,
      {
        app_name: "selected-app",
        machine_name: null,
        org_name: "different-org",
        sub: "custom-subject",
      },
      { issuer: registration.issuer },
    );
    const authentication = await authenticator.authenticateIdToken(token);

    expect(authentication.ok).toBe(true);

    if (!authentication.ok) {
      throw new Error("expected Fly token authentication to succeed");
    }

    const policy = compileTokenIssuancePolicy([
      {
        permissions: { contents: "read" },
        resource: githubRepository("owner", "repository"),
        subjectToken: oidcSubjectTokenConstraint(
          registration.issuer,
          claimEquals("app_name", "selected-app"),
        ),
      },
    ]);
    const request: InstallationAccessTokenRequest = {
      permissions: { contents: "read" },
      resource: createGitHubRepositoryResource({ owner: "owner", repository: "repository" }),
      scope: "contents:read",
    };

    expect(tokenIssuancePolicyPermits(policy, authentication.verifiedSubjectToken, request)).toBe(
      true,
    );
    expect(
      tokenIssuancePolicyPermits(
        policy,
        {
          ...authentication.verifiedSubjectToken,
          claims: { ...authentication.verifiedSubjectToken.claims, app_name: "other-app" },
        },
        request,
      ),
    ).toBe(false);
  });
});
