import type { DashboardRepositoryAccessEntry } from "./session-object.ts";

export interface DashboardTokenRequestView {
  actor: string | null;
  eventName: string;
  expiresAt: string | null;
  id: number;
  mintedPermissions: Record<string, string>;
  oidcContext: Record<string, string | null> | null;
  outcome: "denied" | "internal_error" | "issued" | "upstream_error";
  policyReasons: string[];
  ref: string | null;
  timestamp: string;
}

export function renderDashboardRepositoryListPage(input: {
  githubLogin: string;
  repositories: DashboardRepositoryAccessEntry[];
}): string {
  const repositoryItems =
    input.repositories.length === 0
      ? `<li class="empty">No repositories are currently visible for this GitHub user and app installation set.</li>`
      : input.repositories
          .map(
            (repository) => `
              <li class="repo-card">
                <a href="/dashboard/repositories/${escapeHtml(repository.githubRepoId)}">
                  <strong>${escapeHtml(repository.fullName)}</strong>
                </a>
                <span>${repository.private ? "private" : "public"}</span>
                <span>installation ${repository.installationId}</span>
              </li>`,
          )
          .join("");

  return renderPage({
    body: `
      <header class="page-header">
        <div>
          <p class="eyebrow">Cyspbot Dashboard</p>
          <h1>Repository audit access</h1>
          <p>Signed in as <strong>${escapeHtml(input.githubLogin)}</strong>.</p>
        </div>
        <a class="secondary-link" href="/dashboard/logout">Sign out</a>
      </header>
      <section class="panel">
        <h2>Accessible repositories</h2>
        <ul class="repo-list">${repositoryItems}</ul>
      </section>`,
    title: "Cyspbot dashboard",
  });
}

export function renderDashboardRepositoryDetailsPage(input: {
  githubLogin: string;
  repository: DashboardRepositoryAccessEntry;
  tokenRequests: DashboardTokenRequestView[];
}): string {
  const rows =
    input.tokenRequests.length === 0
      ? `<tr><td colspan="7" class="empty">No token requests recorded for this repository.</td></tr>`
      : input.tokenRequests
          .map((request) => {
            const workflow =
              request.oidcContext?.["workflow"] ?? request.oidcContext?.["workflow_ref"];
            const permissions = Object.entries(request.mintedPermissions)
              .map(([name, access]) => `${escapeHtml(name)}=${escapeHtml(access)}`)
              .join(", ");
            const reasons = request.policyReasons.map(escapeHtml).join(", ");
            const workflowOrPermissions = workflow ?? (permissions.length > 0 ? permissions : "");
            const reasonsPermissionsOrExpiry =
              reasons.length > 0
                ? reasons
                : permissions.length > 0
                  ? permissions
                  : (request.expiresAt ?? "");

            return `
              <tr>
                <td>${escapeHtml(request.timestamp)}</td>
                <td>${escapeHtml(request.outcome)}</td>
                <td>${escapeHtml(request.eventName)}</td>
                <td>${escapeHtml(request.ref ?? "")}</td>
                <td>${escapeHtml(request.actor ?? "")}</td>
                <td>${escapeHtml(workflowOrPermissions)}</td>
                <td>${escapeHtml(reasonsPermissionsOrExpiry)}</td>
              </tr>`;
          })
          .join("");

  return renderPage({
    body: `
      <header class="page-header">
        <div>
          <p class="eyebrow">Cyspbot Dashboard</p>
          <h1>${escapeHtml(input.repository.fullName)}</h1>
          <p>Signed in as <strong>${escapeHtml(input.githubLogin)}</strong>.</p>
        </div>
        <div class="header-actions">
          <a class="secondary-link" href="/dashboard">All repositories</a>
          <a class="secondary-link" href="/dashboard/logout">Sign out</a>
        </div>
      </header>
      <section class="panel meta-grid">
        <div>
          <h2>Repository</h2>
          <p>${escapeHtml(input.repository.fullName)}</p>
        </div>
        <div>
          <h2>Installation</h2>
          <p>${input.repository.installationId}</p>
        </div>
      </section>
      <section class="panel">
        <h2>Last 5 token requests</h2>
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Outcome</th>
              <th>Event</th>
              <th>Ref</th>
              <th>Actor</th>
              <th>Workflow or permissions</th>
              <th>Reasons, permissions, or expiry</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`,
    title: input.repository.fullName,
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPage(input: { body: string; title: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f2ede2;
        --card: rgba(255, 253, 248, 0.92);
        --ink: #172119;
        --muted: #526152;
        --accent: #0f6b42;
        --line: rgba(23, 33, 25, 0.14);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Iowan Old Style", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(15, 107, 66, 0.18), transparent 32%),
          linear-gradient(180deg, #fbf7ef 0%, var(--bg) 100%);
      }
      main {
        max-width: 1080px;
        margin: 0 auto;
        padding: 32px 20px 64px;
      }
      .page-header, .panel, .repo-card {
        backdrop-filter: blur(14px);
      }
      .page-header {
        display: flex;
        gap: 16px;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 24px;
      }
      .panel {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 20px;
        box-shadow: 0 18px 40px rgba(23, 33, 25, 0.08);
      }
      .eyebrow {
        margin: 0 0 8px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: var(--muted);
        font-size: 12px;
      }
      h1, h2, p { margin-top: 0; }
      h1 { margin-bottom: 8px; font-size: clamp(2rem, 5vw, 3.5rem); }
      a { color: var(--accent); }
      .secondary-link {
        display: inline-flex;
        align-items: center;
        min-height: 42px;
        padding: 0 14px;
        border-radius: 999px;
        border: 1px solid var(--line);
        text-decoration: none;
        background: rgba(255, 255, 255, 0.72);
      }
      .repo-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: 12px;
      }
      .repo-card {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        padding: 16px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.72);
      }
      .meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
        margin-bottom: 24px;
      }
      .header-actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.95rem;
      }
      th, td {
        text-align: left;
        padding: 12px 10px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
      }
      .empty {
        color: var(--muted);
      }
      @media (max-width: 720px) {
        .page-header { flex-direction: column; }
        table, thead, tbody, th, td, tr { display: block; }
        thead { display: none; }
        td {
          padding-left: 0;
          padding-right: 0;
        }
      }
    </style>
  </head>
  <body>
    <main>${input.body}</main>
  </body>
</html>`;
}
