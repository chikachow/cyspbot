export type GitHubInstallationPermissionLevel = "read" | "write";

export interface GitHubInstallationPermissions {
  readonly actions?: GitHubInstallationPermissionLevel;
  readonly contents?: GitHubInstallationPermissionLevel;
  readonly pull_requests?: GitHubInstallationPermissionLevel;
}

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

type GitHubInstallationPermissionName = keyof GitHubInstallationPermissions;

const supportedPermissionNames = Object.freeze([
  "actions",
  "contents",
  "pull_requests",
] satisfies readonly GitHubInstallationPermissionName[]);
const supportedPermissionNameSet = new Set<string>(supportedPermissionNames);
const supportedPermissionLevels = new Set<GitHubInstallationPermissionLevel>(["read", "write"]);
const supportedPermissionScopes = new Map<
  string,
  readonly [GitHubInstallationPermissionName, GitHubInstallationPermissionLevel]
>([
  ["actions:read", ["actions", "read"]],
  ["actions:write", ["actions", "write"]],
  ["contents:read", ["contents", "read"]],
  ["contents:write", ["contents", "write"]],
  ["pull_requests:read", ["pull_requests", "read"]],
  ["pull_requests:write", ["pull_requests", "write"]],
]);

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

  return Object.freeze({
    href: resource.href,
    owner: parts[2],
    repository: parts[3],
  });
}

export function createGitHubRepositoryResource(options: {
  readonly owner: string;
  readonly repository: string;
}): GitHubRepositoryResource {
  if (
    !isConstructibleGitHubPathSegment(options.owner) ||
    !isConstructibleGitHubPathSegment(options.repository)
  ) {
    throw new TypeError("invalid GitHub Repository Resource path segment");
  }

  const resource = parseGitHubRepositoryResource(
    `https://api.github.com/repos/${options.owner}/${options.repository}`,
  );

  if (
    resource === null ||
    resource.owner !== options.owner ||
    resource.repository !== options.repository
  ) {
    throw new TypeError("GitHub Repository Resource does not round-trip canonically");
  }

  return resource;
}

export function installationAccessTokenPermissionsAreSupported(
  permissions: unknown,
): permissions is GitHubInstallationPermissions {
  return validatedPermissionEntries(permissions, false) !== null;
}

export function canonicalizeInstallationAccessTokenPermissions(
  permissions: GitHubInstallationPermissions,
): GitHubInstallationPermissions {
  const entries = validatedPermissionEntries(permissions, true);

  if (entries === null) {
    throw new TypeError("invalid GitHub installation permissions");
  }

  return Object.freeze(Object.fromEntries(entries.sort(comparePermissionEntry)));
}

export function installationAccessTokenPermissionLevelCovers(
  configured: GitHubInstallationPermissionLevel | undefined,
  requested: GitHubInstallationPermissionLevel,
): boolean {
  return configured === "write" || configured === requested;
}

export function unionGitHubInstallationPermissions(
  left: GitHubInstallationPermissions,
  right: GitHubInstallationPermissions,
): GitHubInstallationPermissions {
  const permissions: Partial<
    Record<GitHubInstallationPermissionName, GitHubInstallationPermissionLevel>
  > = {};

  for (const name of supportedPermissionNames) {
    const leftLevel = left[name];
    const rightLevel = right[name];

    if (leftLevel === "write" || rightLevel === "write") {
      permissions[name] = "write";
    } else if (leftLevel === "read" || rightLevel === "read") {
      permissions[name] = "read";
    }
  }

  return canonicalizeInstallationAccessTokenPermissions(permissions);
}

function parseGitHubInstallationScope(
  value: string,
): { permissions: GitHubInstallationPermissions; scope: string } | null {
  const scopeTokens = value.split(" ");

  if (scopeTokens.some((scope) => scope.length === 0)) {
    return null;
  }

  const permissions: Partial<
    Record<GitHubInstallationPermissionName, GitHubInstallationPermissionLevel>
  > = {};
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
    permissions: canonicalizeInstallationAccessTokenPermissions(permissions),
    scope: [...seen].sort().join(" "),
  };
}

function comparePermissionEntry(
  [left]: readonly [string, string],
  [right]: readonly [string, string],
): number {
  return left.localeCompare(right);
}

function validatedPermissionEntries(
  permissions: unknown,
  allowEmpty: boolean,
): [GitHubInstallationPermissionName, GitHubInstallationPermissionLevel][] | null {
  if (
    typeof permissions !== "object" ||
    permissions === null ||
    Array.isArray(permissions) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(permissions)) ||
    Object.getOwnPropertySymbols(permissions).length > 0
  ) {
    return null;
  }

  const descriptors = Object.getOwnPropertyDescriptors(permissions);
  const names = Object.getOwnPropertyNames(permissions);

  if (!allowEmpty && names.length === 0) {
    return null;
  }

  const entries: [GitHubInstallationPermissionName, GitHubInstallationPermissionLevel][] = [];

  for (const name of names) {
    const descriptor = descriptors[name];

    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !supportedPermissionNameSet.has(name) ||
      !supportedPermissionLevels.has(descriptor.value as GitHubInstallationPermissionLevel)
    ) {
      return null;
    }

    entries.push([
      name as GitHubInstallationPermissionName,
      descriptor.value as GitHubInstallationPermissionLevel,
    ]);
  }

  return entries;
}

function isGitHubPathSegment(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_.-]+$/u.test(value);
}

function isConstructibleGitHubPathSegment(value: unknown): value is string {
  return typeof value === "string" && value !== "." && value !== ".." && isGitHubPathSegment(value);
}
