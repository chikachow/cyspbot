import type {
  DashboardAuditEntry,
  DashboardRepository,
  DashboardRepositoryListItem,
} from "./types.ts";

export function renderDashboardRepositoryListPage(input: {
  githubLogin: string;
  pullRequestHaikuAdmin: boolean;
  repositories: DashboardRepositoryListItem[];
}): string {
  const activeRepositories = input.repositories.filter(
    (repository) => repository.archivedAt === null,
  );
  const archivedRepositories = input.repositories.filter(
    (repository) => repository.archivedAt !== null,
  );

  return renderPage({
    body: `
      <header class="page-header">
        <div>
          <p class="eyebrow">Cyspbot Dashboard</p>
          <h1>Repository audit</h1>
          <p>Signed in as <strong>${escapeHtml(input.githubLogin)}</strong>.</p>
        </div>
        <div class="header-actions">
          ${
            input.pullRequestHaikuAdmin
              ? '<a class="secondary-link" href="/dashboard/pull-request-haikus">Pull request haikus</a>'
              : ""
          }
          <a class="secondary-link" href="/logout">Sign out</a>
        </div>
      </header>
      ${renderRepositorySection("Active repositories", activeRepositories)}
      ${archivedRepositories.length === 0 ? "" : renderRepositorySection("Archived repositories", archivedRepositories)}`,
    title: "Cyspbot dashboard",
  });
}

export function renderDashboardPullRequestHaikuPage(input: {
  githubLogin: string;
  repositories: DashboardRepositoryListItem[];
}): string {
  const rows =
    input.repositories.length === 0
      ? `<tr><td colspan="5" class="empty">No repositories are currently visible.</td></tr>`
      : input.repositories
          .map((repository) => {
            const enabled = repository.pullRequestHaikuEnabled === true;
            const action = enabled ? "disable" : "enable";
            const label = enabled ? "Disable" : "Enable";

            return `
              <tr>
                <td>${escapeHtml(repository.fullNameDisplay)}</td>
                <td>${escapeHtml(repository.repositoryVisibility)}</td>
                <td>${repository.installationId}</td>
                <td>${enabled ? "Enabled" : "Disabled"}</td>
                <td>
                  <form method="post" action="/dashboard/pull-request-haikus">
                    <input type="hidden" name="repository_id" value="${repository.repositoryId}">
                    <input type="hidden" name="action" value="${action}">
                    <button type="submit">${label}</button>
                  </form>
                </td>
              </tr>`;
          })
          .join("");

  return renderPage({
    body: `
      <header class="page-header">
        <div>
          <p class="eyebrow">Cyspbot Dashboard</p>
          <h1>Pull request haikus</h1>
          <p>Signed in as <strong>${escapeHtml(input.githubLogin)}</strong>.</p>
        </div>
        <div class="header-actions">
          <a class="secondary-link" href="/dashboard">Repository audit</a>
          <a class="secondary-link" href="/logout">Sign out</a>
        </div>
      </header>
      <section class="panel">
        <h2>Repository opt-ins</h2>
        <table>
          <thead>
            <tr>
              <th>Repository</th>
              <th>Visibility</th>
              <th>Installation</th>
              <th>Haikus</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`,
    title: "Pull request haikus",
  });
}

export function renderDashboardRepositoryDetailsPage(input: {
  githubLogin: string;
  issuanceAttempts: DashboardAuditEntry[];
  repository: DashboardRepository;
}): string {
  const rows =
    input.issuanceAttempts.length === 0
      ? `<tr><td colspan="8" class="empty">No Installation Token Issuance rows are recorded for this repository.</td></tr>`
      : input.issuanceAttempts
          .map((request) => renderAuditRow(input.repository.fullNameDisplay, request))
          .join("");

  return renderPage({
    body: `
      <header class="page-header">
        <div>
          <p class="eyebrow">Cyspbot Dashboard</p>
          <h1>${escapeHtml(input.repository.fullNameDisplay)}</h1>
          <p>Signed in as <strong>${escapeHtml(input.githubLogin)}</strong>.</p>
        </div>
        <div class="header-actions">
          <a class="secondary-link" href="/dashboard">All repositories</a>
          <a class="secondary-link" href="/logout">Sign out</a>
        </div>
      </header>
      <section class="panel meta-grid">
        <div>
          <h2>Repository</h2>
          <p>${escapeHtml(input.repository.fullNameDisplay)}</p>
        </div>
        <div>
          <h2>Repository ID</h2>
          <p>${input.repository.repositoryId}</p>
        </div>
        <div>
          <h2>Visibility</h2>
          <p>${escapeHtml(input.repository.repositoryVisibility)}</p>
        </div>
      </section>
      <section class="panel">
        <h2>Last 5 issuance attempts</h2>
        <table>
          <thead>
            <tr>
              <th>Requested</th>
              <th>State</th>
              <th>Outcome</th>
              <th>Event</th>
              <th>Ref</th>
              <th>Actor</th>
              <th>Token</th>
              <th>Reasons</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`,
    title: input.repository.fullNameDisplay,
  });
}

function renderRepositorySection(
  title: string,
  repositories: DashboardRepositoryListItem[],
): string {
  const rows =
    repositories.length === 0
      ? `<tr><td colspan="5" class="empty">No repositories are currently visible.</td></tr>`
      : repositories
          .map((repository) => {
            const [owner, name] = repository.fullNameDisplay.split("/", 2);
            const href =
              owner === undefined || name === undefined
                ? "/dashboard"
                : `/dashboard/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

            return `
              <tr>
                <td><a href="${escapeHtml(href)}">${escapeHtml(repository.fullNameDisplay)}</a></td>
                <td>${escapeHtml(repository.repositoryVisibility)}</td>
                <td>${repository.installationId}</td>
                <td>${escapeHtml(repository.lastInstallationTokenIssuanceAt ?? "")}</td>
                <td>${escapeHtml(repository.lastOutcome ?? "")}</td>
              </tr>`;
          })
          .join("");

  return `
    <section class="panel">
      <h2>${escapeHtml(title)}</h2>
      <table>
        <thead>
          <tr>
            <th>Repository</th>
            <th>Visibility</th>
            <th>Installation</th>
            <th>Last issuance</th>
            <th>Last outcome</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderAuditRow(currentFullNameDisplay: string, request: DashboardAuditEntry): string {
  const permissions = Object.entries(request.permissions)
    .map(([name, access]) => `${escapeHtml(name)}=${escapeHtml(access)}`)
    .join(", ");
  const reasons = request.reasons.map(escapeHtml).join(", ");
  const recordedAs =
    request.fullNameDisplay === currentFullNameDisplay
      ? ""
      : `<p class="muted">recorded as ${escapeHtml(request.fullNameDisplay)}</p>`;

  return `
    <tr>
      <td>${escapeHtml(request.requestedAt)}${recordedAs}</td>
      <td>${escapeHtml(request.auditState)}</td>
      <td>${escapeHtml(request.outcome ?? "")}</td>
      <td>${escapeHtml(request.eventName)}</td>
      <td>${escapeHtml(request.ref ?? "")}</td>
      <td>${escapeHtml(request.actor ?? "")}</td>
      <td>${escapeHtml(request.expiresAt ?? "")}${permissions.length === 0 ? "" : `<p class="muted">${permissions}</p>`}</td>
      <td>${reasons}</td>
    </tr>`;
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
        --bg: #f7f7f4;
        --panel: #ffffff;
        --ink: #151716;
        --muted: #5c625f;
        --accent: #0b5c74;
        --line: #d9ddda;
        --status: #eef6f8;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--ink);
        background: var(--bg);
      }
      main {
        width: min(1180px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 56px;
      }
      .page-header {
        display: flex;
        gap: 16px;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 20px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 18px;
        margin-bottom: 16px;
      }
      .eyebrow {
        margin: 0 0 6px;
        text-transform: uppercase;
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }
      h1, h2, p { margin-top: 0; }
      h1 { margin-bottom: 8px; font-size: 28px; }
      h2 { margin-bottom: 14px; font-size: 17px; }
      a { color: var(--accent); }
      .secondary-link {
        display: inline-flex;
        align-items: center;
        min-height: 38px;
        padding: 0 12px;
        border-radius: 6px;
        border: 1px solid var(--line);
        text-decoration: none;
        background: #fff;
      }
      .secondary-link:focus-visible, a:focus-visible {
        outline: 3px solid rgba(11, 92, 116, 0.35);
        outline-offset: 2px;
      }
      button {
        min-height: 34px;
        padding: 0 12px;
        border-radius: 6px;
        border: 1px solid var(--line);
        background: #fff;
        color: var(--accent);
        font: inherit;
        cursor: pointer;
      }
      button:focus-visible {
        outline: 3px solid rgba(11, 92, 116, 0.35);
        outline-offset: 2px;
      }
      .meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 16px;
      }
      .header-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        font-size: 14px;
      }
      th, td {
        text-align: left;
        padding: 10px 8px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
        overflow-wrap: anywhere;
      }
      th {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
      }
      .empty, .muted {
        color: var(--muted);
      }
      .muted {
        margin: 4px 0 0;
        font-size: 12px;
      }
      @media (max-width: 760px) {
        .page-header { flex-direction: column; }
        table, thead, tbody, th, td, tr { display: block; }
        thead { display: none; }
        tr { border-bottom: 1px solid var(--line); padding: 8px 0; }
        td { border-bottom: 0; padding: 6px 0; }
      }
    </style>
  </head>
  <body>
    <main>${input.body}</main>
  </body>
</html>`;
}
