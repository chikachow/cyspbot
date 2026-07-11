import { describe, expect, it } from "vitest";

import { normalizeInstallationAccessTokenRequest } from "@cyspbot/token-exchange/policy/token-policy";
import {
  fixtureSourceResource,
  fixtureTargetResource,
  mustNormalizeTokenRequest,
  subjectToken,
} from "./support/token-policy-fixtures.ts";

describe("InstallationAccessTokenRequest normalization", () => {
  it("defaults omitted GitHub Actions resource and scope from verified claims", () => {
    const tokenRequest = mustNormalizeTokenRequest(subjectToken, {
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
    const tokenRequest = mustNormalizeTokenRequest(subjectToken, {
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

  it("normalizes read GitHub permission scopes", () => {
    const tokenRequest = mustNormalizeTokenRequest(subjectToken, {
      resource: fixtureSourceResource,
      scope: "pull_requests:read contents:read actions:read",
    });

    expect(tokenRequest).toEqual({
      permissions: {
        actions: "read",
        contents: "read",
        pull_requests: "read",
      },
      resource: new URL(fixtureSourceResource),
      scope: "actions:read contents:read pull_requests:read",
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
      normalizeInstallationAccessTokenRequest(subjectToken, {
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
    "metadata:read",
    "actions:write actions:write",
    "actions",
  ])("rejects unsupported scope %s", (scope) => {
    expect(
      normalizeInstallationAccessTokenRequest(subjectToken, {
        resource: fixtureTargetResource,
        scope,
      }),
    ).toEqual({
      error: "invalid_scope",
      ok: false,
    });
  });
});
