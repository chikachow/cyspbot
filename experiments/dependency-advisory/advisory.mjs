import { createHash } from "node:crypto";
import { classifyDependencyChange } from "./classify.mjs";

export const advisoryPolicy = {
  version: "dependency-advisory-v2",
  nodeMajor: 24,
  repository: "chikachow/cyspbot",
  workflowPath: ".github/workflows/ci.yml",
  appId: 15368,
  checkName: "ci",
  requiredJobs: [
    "ci",
    "format / run",
    "lint / run",
    "env-types / run",
    "typecheck / run",
    "knip / run",
    "test / run",
    "deploy-dry-run / run",
  ],
  // A bounded pilot category, applied uniformly to all package names and sections.
  supportedRecommendation:
    "existing stable nonzero-major patch declarations with native and CI checks passed",
};
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function assessCi(observation, policy = advisoryPolicy) {
  const { pr, workflowRuns = [], checkRuns = [], jobs = [], rules = [] } = observation;
  const result = {
    status: "blocked",
    reasons: [],
    checks: [],
    testedHeadSha: pr.headSha,
    analysisBaseSha: pr.mergeBaseSha,
    testedBaseSha: null,
  };
  const fail = (reason) => result.reasons.push(reason);
  if (observation.repository !== policy.repository) fail("repository_outside_pilot");
  if (!observation.collectionStable || !observation.checksComplete)
    fail("incomplete_or_unstable_collection");
  if (
    !rules.some(
      (rule) =>
        rule.type === "required_status_checks" &&
        rule.parameters?.required_status_checks?.some(
          (check) => check.context === policy.checkName && check.integration_id === policy.appId,
        ),
    )
  )
    fail("required_check_source_not_confirmed");
  const runs = workflowRuns
    .filter(
      (run) =>
        run.path === policy.workflowPath &&
        run.head_sha === pr.headSha &&
        run.event === "pull_request" &&
        run.repository?.full_name === observation.repository &&
        run.pull_requests?.some(
          (pull) => pull.number === pr.number && pull.head?.sha === pr.headSha,
        ),
    )
    .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  const run = runs[0];
  if (!run) {
    fail("matching_workflow_run_missing");
    return result;
  }
  if (runs[1]?.run_number === run.run_number && runs[1]?.run_attempt === run.run_attempt)
    fail("ambiguous_workflow_run");
  result.workflow = {
    id: run.id,
    attempt: run.run_attempt,
    path: run.path,
    headSha: run.head_sha,
    url: run.html_url,
  };
  if (run.status !== "completed" || run.conclusion !== "success") fail("workflow_not_successful");
  if (!observation.workflowDefinitionUnchanged) fail("workflow_definition_not_verified");
  for (const name of policy.requiredJobs) {
    const matched = jobs.filter(
      (job) => job.name === name && job.run_id === run.id && job.run_attempt === run.run_attempt,
    );
    if (matched.length !== 1) {
      result.checks.push({ name, status: matched.length ? "ambiguous" : "missing" });
      continue;
    }
    const job = matched[0];
    const check = checkRuns.find(
      (item) =>
        item.id === job.id &&
        item.name === name &&
        item.app?.id === policy.appId &&
        item.head_sha === pr.headSha &&
        item.check_suite?.id === run.check_suite_id,
    );
    const success =
      check &&
      check.status === "completed" &&
      check.conclusion === "success" &&
      job.status === "completed" &&
      job.conclusion === "success";
    result.checks.push({
      name,
      status: success ? "passed" : "not_passed",
      jobId: job.id,
      checkRunId: check?.id ?? null,
      appId: check?.app?.id ?? null,
      url: job.html_url,
    });
  }
  if (result.checks.some((check) => check.status !== "passed")) fail("required_job_not_passed");
  if (!result.reasons.length) result.status = "passed_for_head";
  return result;
}

export function makeAdvisory(observation, native = null, policy = advisoryPolicy) {
  const structure = classifyDependencyChange(observation.packet);
  const ci = assessCi(observation, policy);
  const policySha256 = sha256(JSON.stringify(policy));
  const sourceInputSha256 = sha256(JSON.stringify(observation.packet));
  const inputBound =
    observation.inputSha256 === sourceInputSha256 &&
    observation.packet.headSha === observation.pr.headSha &&
    observation.packet.baseSha === observation.pr.mergeBaseSha;
  const nativePassed =
    native?.status === "passed" &&
    native.repository === observation.repository &&
    native.headSha === observation.pr.headSha &&
    native.inputSha256 === sourceInputSha256 &&
    native.policySha256 === policySha256 &&
    native.lockUnchanged === true &&
    native.prStillCurrent === true &&
    native.ciStillCurrent === true &&
    native.node?.split(".")[0] === `v${policy.nodeMajor}` &&
    native.steps?.length === 2 &&
    ["strict_peers", "frozen_engines"].every(
      (name) =>
        native.steps.filter(
          (step) => step.name === name && step.exitCode === 0 && step.lockUnchanged === true,
        ).length === 1,
    );
  const transitions = structure.manifestUpdates;
  const patchCategory =
    transitions.length > 0 &&
    transitions.every((update) => update.kind === "patch" && !update.versionZero);
  const blocked = [];
  if (!inputBound) blocked.push("input_identity_mismatch");
  if (structure.scope !== "dependency_update") blocked.push("structural_scope_unresolved");
  if (!patchCategory) blocked.push("acceptance_category_unsettled");
  if (ci.status !== "passed_for_head") blocked.push("ci_unverified");
  if (!nativePassed) blocked.push("native_validation_unverified");
  if (!observation.collectionStable || observation.pr.state !== "open" || observation.pr.draft)
    blocked.push("pr_not_current_open_candidate");
  const candidate = blocked.length === 0;
  return {
    advisoryPolicyVersion: policy.version,
    policySha256,
    sourceInputSha256,
    repository: observation.repository,
    number: observation.pr.number,
    url: observation.pr.url,
    observedAt: observation.observedAt,
    baseTipSha: observation.pr.baseTipSha,
    mergeBaseSha: observation.pr.mergeBaseSha,
    headSha: observation.pr.headSha,
    recommendation: candidate ? "trivially_acceptable_candidate" : "no_recommendation",
    reason: candidate
      ? "Only supported dependency updates were observed; the direct declaration changes are stable patches, verified CI jobs passed for this head, and native peer/engine checks passed without changing its lockfile. Ordinary patch risk remains accepted."
      : null,
    blocked,
    structure,
    ci,
    native: nativePassed ? native : { status: native ? "unverified_or_failed" : "not_run" },
    limits: [
      "Advisory only; no GitHub approval or merge.",
      "CI attests the reported PR head; the actual tested merge base is not independently attested.",
      "Valid transitive changes need not be minimal or caused solely by a named direct bump.",
      "Regressions within accepted ordinary patch risk remain possible.",
    ],
  };
}

export function renderCard(card) {
  const safe = (value) => String(value).replace(/[\r\n|`<>]/g, " ");
  const lines = [
    `# Dependency advisory: ${safe(card.repository)} #${card.number}`,
    "",
    `**${card.recommendation}** — ${card.reason ?? card.blocked.join(", ")}`,
    "",
    `Observed: ${card.observedAt}. Head: \`${card.headSha}\`. Merge base: \`${card.mergeBaseSha}\`.`,
    "",
    "| Manifest | Section | Package | Before | After | Change |",
    "|---|---|---|---|---|---|",
  ];
  for (const update of card.structure.manifestUpdates)
    lines.push(
      `| ${[update.file, update.section, update.name, update.from, update.to, update.kind].map(safe).join(" | ")} |`,
    );
  lines.push(
    "",
    `CI: **${card.ci.status}**. Native checks: **${card.native.status}**.`,
    "",
    `Changed lockfile records: ${card.structure.lockfile.packages.length} package records, ${card.structure.lockfile.snapshots.length} snapshots. The JSON card retains all semantic operations and importer changes.`,
    "",
    ...card.structure.findings.map(
      (item) => `- ${safe(item.code)}: ${safe(item.file)} ${safe(item.path.join("/"))}`,
    ),
    "",
    ...card.limits.map((limit) => `- ${limit}`),
    "",
  );
  return lines.join("\n");
}
