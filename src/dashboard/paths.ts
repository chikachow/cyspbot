export function parseDashboardRepositoryRoute(
  pathname: string,
): { name: string; owner: string } | null {
  const prefix = "/dashboard/repositories/";

  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const parts = pathname.slice(prefix.length).split("/");

  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    return null;
  }

  try {
    const owner = decodeURIComponent(parts[0]);
    const name = decodeURIComponent(parts[1]);

    if (owner.length === 0 || name.length === 0) {
      return null;
    }

    return { name, owner };
  } catch {
    return null;
  }
}

export function sanitizeDashboardReturnTo(value: string | null): string {
  if (value === null) {
    return "/dashboard";
  }

  if (value === "/dashboard") {
    return value;
  }

  if (parseDashboardRepositoryRoute(value) !== null) {
    return value;
  }

  return "/dashboard";
}
