import test from "node:test";
import assert from "node:assert/strict";
import { advisoryPolicy, sha256, assessCi, makeAdvisory } from "./advisory.mjs";
import { nativeArguments } from "./native.mjs";
const head = "a".repeat(40),
  base = "b".repeat(40);
function fixture() {
  const packet = {
    complete: true,
    baseSha: base,
    headSha: head,
    fileCount: 1,
    files: [
      {
        path: "package.json",
        status: "modified",
        beforeMode: "100644",
        afterMode: "100644",
        before: '{"dependencies":{"anything":"1.0.0"}}',
        after: '{"dependencies":{"anything":"1.0.1"}}',
      },
    ],
  };
  const run = {
    id: 1,
    run_attempt: 1,
    run_number: 1,
    path: advisoryPolicy.workflowPath,
    head_sha: head,
    event: "pull_request",
    repository: { full_name: advisoryPolicy.repository },
    pull_requests: [{ number: 1, head: { sha: head } }],
    status: "completed",
    conclusion: "success",
    check_suite_id: 10,
  };
  return {
    repository: advisoryPolicy.repository,
    pr: { number: 1, headSha: head, mergeBaseSha: base, state: "open", draft: false },
    packet,
    inputSha256: sha256(JSON.stringify(packet)),
    collectionStable: true,
    checksComplete: true,
    workflowDefinitionUnchanged: true,
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: "ci", integration_id: advisoryPolicy.appId }],
        },
      },
    ],
    workflowRuns: [run],
    jobs: advisoryPolicy.requiredJobs.map((name, i) => ({
      name,
      id: 100 + i,
      run_id: 1,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
    })),
    checkRuns: advisoryPolicy.requiredJobs.map((name, i) => ({
      name,
      id: 100 + i,
      app: { id: advisoryPolicy.appId },
      head_sha: head,
      check_suite: { id: 10 },
      status: "completed",
      conclusion: "success",
    })),
  };
}
function native(observation) {
  return {
    status: "passed",
    repository: observation.repository,
    headSha: head,
    inputSha256: observation.inputSha256,
    policySha256: sha256(JSON.stringify(advisoryPolicy)),
    lockUnchanged: true,
    prStillCurrent: true,
    ciStillCurrent: true,
    node: "v24.0.0",
    steps: ["strict_peers", "frozen_engines"].map((name) => ({
      name,
      exitCode: 0,
      lockUnchanged: true,
    })),
  };
}
test("complete trusted head evidence yields an advisory candidate with explicit base limit", () => {
  const observation = fixture();
  const result = makeAdvisory(observation, native(observation));
  assert.equal(result.recommendation, "trivially_acceptable_candidate");
  assert.equal(result.ci.testedBaseSha, null);
});
test("CI rejects wrong app, suite, head, missing jobs, neutral/skipped, definition changes and unstable collection", () => {
  const mutations = [
    (o) => o.checkRuns[0].app.id++,
    (o) => o.checkRuns[0].check_suite.id++,
    (o) => (o.checkRuns[0].head_sha = base),
    (o) => o.jobs.pop(),
    (o) => (o.jobs[0].conclusion = "skipped"),
    (o) => (o.checkRuns[0].conclusion = "neutral"),
    (o) => (o.workflowDefinitionUnchanged = false),
    (o) => (o.collectionStable = false),
    (o) => (o.checksComplete = false),
    (o) => (o.rules = []),
    (o) => (o.workflowRuns[0].pull_requests = []),
    (o) => (o.workflowRuns[0].event = "push"),
  ];
  for (const mutate of mutations) {
    const observation = fixture();
    mutate(observation);
    assert.equal(assessCi(observation).status, "blocked");
  }
});
test("a pending latest rerun cannot borrow older success", () => {
  const observation = fixture();
  observation.workflowRuns.push({
    ...observation.workflowRuns[0],
    run_attempt: 2,
    status: "in_progress",
    conclusion: null,
  });
  assert.equal(assessCi(observation).status, "blocked");
});
test("native receipt must bind exact input, policy, head and both distinct checks", () => {
  const observation = fixture();
  const mutations = [
    (n) => (n.headSha = base),
    (n) => (n.inputSha256 = "wrong"),
    (n) => (n.policySha256 = "wrong"),
    (n) => (n.prStillCurrent = false),
    (n) => (n.ciStillCurrent = false),
    (n) => (n.node = "v26.0.0"),
    (n) => (n.steps[1].name = "strict_peers"),
    (n) => (n.steps[0].exitCode = 1),
    (n) => (n.steps[0].lockUnchanged = false),
  ];
  for (const mutate of mutations) {
    const receipt = native(observation);
    mutate(receipt);
    assert.equal(makeAdvisory(observation, receipt).recommendation, "no_recommendation");
  }
});
test("minor updates and closed/draft PRs remain outside candidate policy", () => {
  for (const mutate of [
    (o) => (o.pr.draft = true),
    (o) => (o.pr.state = "closed"),
    (o) => (o.packet.files[0].after = '{"dependencies":{"anything":"1.1.0"}}'),
  ]) {
    const observation = fixture();
    mutate(observation);
    assert.equal(
      makeAdvisory(observation, native(observation)).recommendation,
      "no_recommendation",
    );
  }
});
test("native commands suppress lifecycle and pnpmfile execution and independently assess submitted lock", () => {
  for (const name of ["strict_peers", "frozen_engines"]) {
    const args = nativeArguments(name, "/tmp/store");
    for (const flag of ["--ignore-scripts", "--ignore-pnpmfile", "--strict-peer-dependencies"])
      assert.ok(args.includes(flag));
    assert.ok(args.includes(name === "strict_peers" ? "--resolution-only" : "--frozen-lockfile"));
  }
  assert.throws(() => nativeArguments("unknown", "/tmp/store"));
});
test("packet revisions and content cannot borrow a previous native receipt", () => {
  for (const mutate of [
    (o) => (o.packet.headSha = "c".repeat(40)),
    (o) => (o.packet.baseSha = "c".repeat(40)),
    (o) => (o.packet.files[0].after = '{"dependencies":{"anything":"1.0.2"}}'),
  ]) {
    const observation = fixture();
    const receipt = native(observation);
    mutate(observation);
    assert.ok(makeAdvisory(observation, receipt).blocked.includes("input_identity_mismatch"));
  }
});

test("version-zero patches remain outside the stable patch category", () => {
  const observation = fixture();
  observation.packet.files[0].before = '{"dependencies":{"anything":"0.1.0"}}';
  observation.packet.files[0].after = '{"dependencies":{"anything":"0.1.1"}}';
  observation.inputSha256 = sha256(JSON.stringify(observation.packet));
  assert.equal(
    makeAdvisory(observation, native(observation)).structure.manifestUpdates[0].kind,
    "patch",
  );
  assert.ok(
    makeAdvisory(observation, native(observation)).blocked.includes(
      "acceptance_category_unsettled",
    ),
  );
});
