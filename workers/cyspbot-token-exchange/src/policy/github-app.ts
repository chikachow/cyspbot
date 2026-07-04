export function isGitHubAppSlug(value: string | undefined): value is string {
  return value !== undefined && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value);
}

export function parseGitHubAppSlug(value: string): string | null {
  return isGitHubAppSlug(value) ? value : null;
}
