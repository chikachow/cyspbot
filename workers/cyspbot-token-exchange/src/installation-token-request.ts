export type GitHubInstallationPermissions = Record<string, string>;

export interface InstallationAccessTokenRequest {
  readonly permissions: GitHubInstallationPermissions;
  readonly resource: GitHubRepositoryResource;
  readonly scope: string;
}

export interface GitHubRepositoryResource {
  readonly href: string;
  readonly owner: string;
  readonly repository: string;
}

const supportedPermissionScopes = new Map<string, readonly [string, string]>([
  ["actions:read", ["actions", "read"]],
  ["actions:write", ["actions", "write"]],
  ["contents:read", ["contents", "read"]],
  ["contents:write", ["contents", "write"]],
  ["pull_requests:read", ["pull_requests", "read"]],
  ["pull_requests:write", ["pull_requests", "write"]],
]);
const supportedPermissionPairs = new Set(
  [...supportedPermissionScopes.values()].map(permissionPairKey),
);

export function normalizeInstallationAccessTokenRequest(options: {
  resource: string;
  scope: string | null;
}): { ok: true; tokenRequest: InstallationAccessTokenRequest } | { error: string; ok: false } {
  const resource = parseGitHubRepositoryResource(options.resource);

  if (resource === null) {
    return { error: "invalid_target", ok: false };
  }

  const scope = parseGitHubInstallationScope(options.scope ?? "contents:write pull_requests:write");

  if (scope === null) {
    return { error: "invalid_scope", ok: false };
  }

  return {
    ok: true,
    tokenRequest: {
      permissions: scope.permissions,
      resource,
      scope: scope.scope,
    },
  };
}

export function parseGitHubRepositoryResource(value: string): GitHubRepositoryResource | null {
  if (value.length === 0) {
    return null;
  }

  let resource: URL;

  try {
    resource = new URL(value);
  } catch {
    return null;
  }

  if (
    resource.href !== value ||
    resource.protocol !== "https:" ||
    resource.hostname !== "api.github.com" ||
    resource.port.length !== 0 ||
    resource.username.length !== 0 ||
    resource.password.length !== 0 ||
    resource.search.length !== 0 ||
    resource.hash.length !== 0
  ) {
    return null;
  }

  const parts = resource.pathname.split("/");

  if (
    parts.length !== 4 ||
    parts[0] !== "" ||
    parts[1] !== "repos" ||
    !isGitHubPathSegment(parts[2]) ||
    !isGitHubPathSegment(parts[3])
  ) {
    return null;
  }

  return {
    href: resource.href,
    owner: parts[2],
    repository: parts[3],
  };
}

export function installationAccessTokenPermissionsAreSupported(
  permissions: GitHubInstallationPermissions,
): boolean {
  const entries = Object.entries(permissions);

  return (
    entries.length > 0 &&
    entries.every(([name, level]) => supportedPermissionPairs.has(permissionPairKey([name, level])))
  );
}

export function canonicalizeInstallationAccessTokenPermissions(
  permissions: GitHubInstallationPermissions,
): GitHubInstallationPermissions {
  return Object.fromEntries(Object.entries(permissions).sort(comparePermissionEntry));
}

export function installationAccessTokenPermissionsEqual(
  left: GitHubInstallationPermissions,
  right: GitHubInstallationPermissions,
): boolean {
  const leftEntries = Object.entries(canonicalizeInstallationAccessTokenPermissions(left));
  const rightEntries = Object.entries(canonicalizeInstallationAccessTokenPermissions(right));

  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([leftName, leftLevel], index) => {
      const [rightName, rightLevel] = rightEntries[index] ?? [];

      return leftName === rightName && leftLevel === rightLevel;
    })
  );
}

function parseGitHubInstallationScope(
  value: string,
): { permissions: GitHubInstallationPermissions; scope: string } | null {
  const scopeTokens = value.split(" ");

  if (scopeTokens.some((scope) => scope.length === 0)) {
    return null;
  }

  const permissions: GitHubInstallationPermissions = {};
  const seen = new Set<string>();

  for (const scope of scopeTokens) {
    const permission = supportedPermissionScopes.get(scope);

    if (permission === undefined) {
      return null;
    }

    if (seen.has(scope)) {
      continue;
    }

    const [name, level] = permission;

    if (permissions[name] !== undefined) {
      return null;
    }

    permissions[name] = level;
    seen.add(scope);
  }

  return {
    permissions,
    scope: [...seen].sort().join(" "),
  };
}

function comparePermissionEntry(
  [left]: readonly [string, string],
  [right]: readonly [string, string],
): number {
  return left.localeCompare(right);
}

function permissionPairKey([name, level]: readonly [string, string]): string {
  return JSON.stringify([name, level]);
}

function isGitHubPathSegment(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_.-]+$/u.test(value);
}
