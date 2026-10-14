import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { advisoryPolicy, makeAdvisory, renderCard, sha256 } from "./advisory.mjs";

export function githubApi(path) {
  return JSON.parse(
    execFileSync("gh", ["api", "--method", "GET", "--hostname", "github.com", path], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 15 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}
function pages(api, path, key = null, limit = 20) {
  const values = [];
  for (let page = 1; page <= limit; page++) {
    const response = api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const batch = key ? response[key] : response;
    if (!Array.isArray(batch)) throw new Error("Invalid GitHub page");
    values.push(...batch);
    if (batch.length < 100) {
      if (key && Number.isInteger(response.total_count) && values.length !== response.total_count)
        throw new Error("Incomplete paginated response");
      return values;
    }
  }
  throw new Error("Pagination budget exceeded");
}
const blobHash = (bytes) =>
  createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
function blob(api, repo, sha) {
  const value = api(`repos/${repo}/git/blobs/${sha}`);
  if (value.encoding !== "base64" || value.size > 1024 * 1024) throw new Error("Unsupported blob");
  const bytes = Buffer.from(value.content, "base64");
  if (bytes.length !== value.size || blobHash(bytes) !== sha) throw new Error("Blob hash mismatch");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("Non-UTF-8 blob");
  return text;
}
function tree(api, repo, sha) {
  const response = api(`repos/${repo}/git/trees/${sha}?recursive=1`);
  if (response.truncated || !Array.isArray(response.tree)) throw new Error("Incomplete tree");
  return new Map(
    response.tree.filter((entry) => entry.type !== "tree").map((entry) => [entry.path, entry]),
  );
}
const prIdentity = (pr) =>
  JSON.stringify([pr.head.sha, pr.base.sha, pr.base.ref, pr.updated_at, pr.state, pr.draft]);

export function collectObservation(repository, number, api = githubApi, policy = advisoryPolicy) {
  if (repository !== policy.repository || !Number.isSafeInteger(number) || number < 1)
    throw new Error("Invalid pilot PR");
  const start = api(`repos/${repository}/pulls/${number}`);
  const headRepository = start.head.repo.full_name;
  const compare = api(`repos/${repository}/compare/${start.base.sha}...${start.head.sha}`);
  const mergeBaseSha = compare.merge_base_commit.sha;
  const beforeTree = tree(api, repository, mergeBaseSha);
  const afterTree = tree(api, headRepository, start.head.sha);
  const apiFiles = pages(api, `repos/${repository}/pulls/${number}/files`);
  const changed = [...new Set([...beforeTree.keys(), ...afterTree.keys()])]
    .filter(
      (path) =>
        beforeTree.get(path)?.sha !== afterTree.get(path)?.sha ||
        beforeTree.get(path)?.mode !== afterTree.get(path)?.mode,
    )
    .sort((a, b) => a.localeCompare(b));
  const expectedPaths = apiFiles.flatMap((file) =>
    file.status === "renamed" ? [file.previous_filename, file.filename] : [file.filename],
  );
  if (
    apiFiles.length !== start.changed_files ||
    new Set(expectedPaths).size !== changed.length ||
    changed.some((path) => !expectedPaths.includes(path))
  )
    throw new Error("Tree and PR inventory disagree");
  const files = changed.map((path) => {
    const a = beforeTree.get(path);
    const b = afterTree.get(path);
    const supported =
      path === "pnpm-lock.yaml" || path === "package.json" || path.endsWith("/package.json");
    return {
      path,
      status: a && b ? "modified" : a ? "removed" : "added",
      beforeMode: a?.mode,
      afterMode: b?.mode,
      beforeBlobSha: a?.sha,
      afterBlobSha: b?.sha,
      before: supported && a?.type === "blob" ? blob(api, repository, a.sha) : null,
      after: supported && b?.type === "blob" ? blob(api, headRepository, b.sha) : null,
    };
  });
  const rules = api(`repos/${repository}/rules/branches/${encodeURIComponent(start.base.ref)}`);
  const checkRuns = pages(
    api,
    `repos/${repository}/commits/${start.head.sha}/check-runs?filter=all`,
    "check_runs",
  );
  const workflowRuns = pages(
    api,
    `repos/${repository}/actions/runs?head_sha=${start.head.sha}&event=pull_request`,
    "workflow_runs",
  );
  const relevant = workflowRuns
    .filter((run) => run.path === policy.workflowPath && run.head_sha === start.head.sha)
    .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
  const jobs = relevant
    ? pages(
        api,
        `repos/${repository}/actions/runs/${relevant.id}/attempts/${relevant.run_attempt}/jobs`,
        "jobs",
      )
    : [];
  const workflowPaths = [...beforeTree.keys()].filter(
    (path) => path.startsWith(".github/workflows/") && /\.ya?ml$/.test(path),
  );
  const workflowDefinitionUnchanged =
    workflowPaths.includes(policy.workflowPath) &&
    workflowPaths.every((path) => beforeTree.get(path).sha === afterTree.get(path)?.sha) &&
    [...afterTree.keys()].filter(
      (path) => path.startsWith(".github/workflows/") && /\.ya?ml$/.test(path),
    ).length === workflowPaths.length;
  const end = api(`repos/${repository}/pulls/${number}`);
  const runFresh = relevant ? api(`repos/${repository}/actions/runs/${relevant.id}`) : null;
  const observation = {
    repository,
    observedAt: new Date().toISOString(),
    pr: {
      number,
      title: start.title,
      url: start.html_url,
      state: start.state,
      draft: start.draft,
      headRepository,
      headSha: start.head.sha,
      baseTipSha: start.base.sha,
      baseRef: start.base.ref,
      mergeBaseSha,
    },
    collectionStable:
      prIdentity(start) === prIdentity(end) &&
      (!relevant ||
        (runFresh.run_attempt === relevant.run_attempt &&
          runFresh.status === relevant.status &&
          runFresh.conclusion === relevant.conclusion)),
    checksComplete: true,
    workflowDefinitionUnchanged,
    packet: {
      complete: true,
      baseSha: mergeBaseSha,
      headSha: start.head.sha,
      fileCount: files.length,
      files,
    },
    rules,
    checkRuns,
    workflowRuns,
    jobs,
    workflowBlobs: Object.fromEntries(
      workflowPaths.map((path) => [path, beforeTree.get(path).sha]),
    ),
    prStart: start,
    prEnd: end,
  };
  observation.inputSha256 = sha256(JSON.stringify(observation.packet));
  return observation;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , repository, directory, ...numbers] = process.argv;
  if (
    !directory ||
    !numbers.length ||
    numbers.length > 20 ||
    numbers.some((n) => !/^[1-9]\d*$/.test(n))
  )
    throw new Error("Usage: github.mjs OWNER/REPO NEW_OUTPUT_DIRECTORY PR_NUMBER... (maximum 20)");
  mkdirSync(directory, { recursive: false });
  const selection = {
    repository,
    collectedAt: new Date().toISOString(),
    policy: advisoryPolicy,
    numbers: numbers.map(Number),
    note: "Manually selected observations; selection alone does not establish a prospective holdout. No GitHub writes or PR code execution.",
  };
  writeFileSync(resolve(directory, "selection.json"), JSON.stringify(selection, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  for (const value of numbers) {
    const number = Number(value);
    try {
      const observation = collectObservation(repository, number);
      const card = makeAdvisory(observation);
      writeFileSync(
        resolve(directory, `${number}.observation.json`),
        JSON.stringify(observation, null, 2) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      writeFileSync(
        resolve(directory, `${number}.card.json`),
        JSON.stringify(card, null, 2) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      writeFileSync(resolve(directory, `${number}.card.md`), renderCard(card), {
        mode: 0o600,
        flag: "wx",
      });
      console.log(
        JSON.stringify({
          number,
          scope: card.structure.scope,
          ci: card.ci.status,
          blocked: card.blocked,
        }),
      );
    } catch (error) {
      // gh's stderr can contain untrusted source text; keep diagnostics bounded to a local failure marker.
      writeFileSync(
        resolve(directory, `${number}.failure.json`),
        JSON.stringify({
          number,
          status: "collection_failed",
          reason:
            error instanceof Error && !Object.hasOwn(error, "stderr")
              ? error.message
              : "GitHub request failed",
        }) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      console.log(JSON.stringify({ number, status: "collection_failed" }));
    }
  }
}
