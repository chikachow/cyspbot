import { describe, expect, it } from "vitest";

import { normalizeInstallationAccessTokenRequest } from "@cyspbot/token-exchange/policy/token-policy";
import {
  fixtureSourceResource,
  fixtureTargetResource,
  mustNormalizeTokenRequest,
  principal,
} from "./support/token-policy-fixtures.ts";

describe("InstallationAccessTokenRequest normalization", () => {
  it("defaults omitted resource and scope from the verified principal", () => {
    const tokenRequest = mustNormalizeTokenRequest(principal, {
      resource: null,
      scope: null,
    });

    expect(tokenRequest).toEqual({
      permissions: {
        contents: "write",
        pull_requests: "write",
      },
      resource: new URL(fixtureSourceResource),
      scope: "contents:write pull_requests:write",
    });
  });

  it("normalizes reordered GitHub permission scopes", () => {
    const tokenRequest = mustNormalizeTokenRequest(principal, {
      resource: fixtureSourceResource,
      scope: "pull_requests:write contents:write",
    });

    expect(tokenRequest).toEqual({
      permissions: {
        contents: "write",
        pull_requests: "write",
      },
      resource: new URL(fixtureSourceResource),
      scope: "contents:write pull_requests:write",
    });
  });

  it.each([
    "fixture-target-owner/fixture-target-repository",
    " https://api.github.com/repos/fixture-target-owner/fixture-target-repository",
    "https://api.github.com/repos/fixture-target-owner/fixture-target-repository ",
    "https://github.com/fixture-target-owner/fixture-target-repository",
    "https://api.github.com/repos/fixture-target-owner/fixture-target-repository/",
    "https://api.github.com/repos/fixture-target-owner/fixture-target-repository?x=1",
    "https://api.github.com/repos/fixture-target-owner/fixture-target-repository#fragment",
    "https://user@api.github.com/repos/fixture-target-owner/fixture-target-repository",
    "https://api.github.com/repos/fixture-target-owner%2Ffixture-other-target/fixture-target-repository",
    "https://api.github.com/repos/fixture-target-owner/../fixture-target-repository",
    "https://api.github.com/repos/fixture-target-owner/fixture-target-repository/actions/workflows/x.yml",
  ])("rejects non-canonical resource %s", (resource) => {
    expect(
      normalizeInstallationAccessTokenRequest(principal, {
        resource,
        scope: "actions:write",
      }),
    ).toEqual({
      error: "invalid_target",
      ok: false,
    });
  });

  it.each([
    "",
    " ",
    " actions:write",
    "actions:write ",
    "contents:write  pull_requests:write",
    "contents:write\tpull_requests:write",
    "contents:write\npull_requests:write",
    "actions:read",
    "metadata:read",
    "actions:write actions:write",
    "actions",
  ])("rejects unsupported scope %s", (scope) => {
    expect(
      normalizeInstallationAccessTokenRequest(principal, {
        resource: fixtureTargetResource,
        scope,
      }),
    ).toEqual({
      error: "invalid_scope",
      ok: false,
    });
  });
});
