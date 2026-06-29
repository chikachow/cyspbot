export interface ParsedGitHubAppAudience {
  audience: string;
  slug: string;
}

export function parseGitHubAppAudience(value: string): ParsedGitHubAppAudience | null {
  if (value.length === 0) {
    return null;
  }

  let audience: URL;

  try {
    audience = new URL(value);
  } catch {
    return null;
  }

  if (
    audience.href !== value ||
    audience.protocol !== "https:" ||
    audience.hostname !== "github.com" ||
    audience.port.length !== 0 ||
    audience.username.length !== 0 ||
    audience.password.length !== 0 ||
    audience.search.length !== 0 ||
    audience.hash.length !== 0
  ) {
    return null;
  }

  const parts = audience.pathname.split("/");

  if (parts.length !== 3 || parts[0] !== "" || parts[1] !== "apps") {
    return null;
  }

  const slug = parts[2];

  if (!isGitHubAppSlug(slug)) {
    return null;
  }

  return {
    audience: value,
    slug,
  };
}

export function isGitHubAppSlug(value: string | undefined): value is string {
  return value !== undefined && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value);
}
