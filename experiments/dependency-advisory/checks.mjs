import assert from "node:assert/strict";
import test from "node:test";
import { stringify } from "yaml";
import { classifyDependencyChange, classifyVersionChange } from "./classify.mjs";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const integrity = "sha512-" + Buffer.alloc(64).toString("base64");
const file = (path, before, after) => ({
  path,
  status: "modified",
  beforeMode: "100644",
  afterMode: "100644",
  before,
  after,
});
function fixture({
  name = "ordinary-package",
  section = "devDependencies",
  from = "1.2.3",
  to = "1.2.4",
} = {}) {
  const manifest = (v) => ({
    name: "fixture",
    scripts: { test: "node test.mjs" },
    [section]: { [name]: v },
  });
  const lock = (v) => ({
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: false },
    importers: { ".": { [section]: { [name]: { specifier: v, version: v } } } },
    packages: { [`${name}@${v}`]: { resolution: { integrity } } },
    snapshots: { [`${name}@${v}`]: {} },
  });
  return {
    baseSha,
    headSha,
    complete: true,
    fileCount: 2,
    files: [
      file("package.json", JSON.stringify(manifest(from)), JSON.stringify(manifest(to))),
      file("pnpm-lock.yaml", stringify(lock(from)), stringify(lock(to))),
    ],
  };
}
function editManifest(packet, update) {
  const value = JSON.parse(packet.files[0].after);
  update(value);
  packet.files[0].after = JSON.stringify(value);
}
// The test oracle uses authored graphs rather than deriving expected outcomes from the classifier.
function editLock(packet, update) {
  // JSON is also YAML, allowing mutation without using the production parser.
  const p = fixtureJsonLock(packet);
  update(p);
  packet.files[1].after = JSON.stringify(p);
}
function fixtureJsonLock(packet) {
  const m = JSON.parse(packet.files[0].after);
  const section = ["devDependencies", "dependencies", "optionalDependencies"].find((key) => m[key]);
  const [name, v] = Object.entries(m[section])[0];
  return {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: false },
    importers: { ".": { [section]: { [name]: { specifier: v, version: v } } } },
    packages: { [`${name}@${v}`]: { resolution: { integrity } } },
    snapshots: { [`${name}@${v}`]: {} },
  };
}
const codes = (result) => result.findings.map((item) => item.code);

test("all package identities and regular/development/optional sections use the same rule", () => {
  for (const name of [
    "ordinary-package",
    "@unlisted/vendor",
    "typescript",
    "@testing-library/dom",
  ]) {
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const result = classifyDependencyChange(fixture({ name, section }));
      assert.equal(result.scope, "dependency_update", `${name}/${section}`);
      assert.equal(result.manifestUpdates[0].kind, "patch");
      assert.equal(result.manifestUpdates[0].section, section);
      assert.equal(result.triviallyAcceptable, null);
      assert.equal(result.readiness.status, "not_evaluated");
    }
  }
});

test("version classifications preserve major, minor, downgrade, zero, prerelease and ranges", () => {
  for (const [from, to, kind] of [
    ["1.2.3", "2.0.0", "major"],
    ["1.2.3", "1.3.0", "minor"],
    ["1.2.3", "1.2.2", "downgrade"],
    ["0.1.0", "0.2.0", "minor"],
    ["1.0.0-rc.1", "1.0.0", "prerelease"],
    ["^1.2.3", "^1.2.4", "patch"],
    ["~1.2.3", "^1.2.3", "range_operator_change"],
    ["1.0.0", "1.0.0+build", "build_metadata"],
    ["01.2.3", "1.2.4", "other_specifier_change"],
    ["1.0.0-01", "1.0.0", "other_specifier_change"],
    ["workspace:*", "https://example.test/a.tgz", "other_specifier_change"],
    ["9007199254740993.0.0", "9007199254740994.0.0", "major"],
  ])
    assert.equal(classifyVersionChange(from, to).kind, kind, `${from}/${to}`);
  assert.equal(classifyVersionChange("0.1.0", "0.2.0").versionZero, true);
  assert.equal(classifyVersionChange("^1.2.3", "^1.2.4").range, true);
  assert.equal(classifyDependencyChange(fixture({ to: "2.0.0" })).scope, "dependency_update");
});

test("a script change mixed with a dependency bump is outside policy", () => {
  const p = fixture();
  editManifest(p, (m) => {
    m.scripts.test = "true";
  });
  assert.ok(codes(classifyDependencyChange(p)).includes("non_dependency_manifest_change"));
});

test("every path and mode counts even for formatting-only extra files", () => {
  const p = fixture();
  p.files.push(file("README.md", "a", "a\n"));
  p.fileCount++;
  assert.equal(classifyDependencyChange(p).scope, "requires_judgment");
  const q = fixture();
  q.files[0].afterMode = "100755";
  assert.ok(codes(classifyDependencyChange(q)).includes("file_mode_outside_policy"));
  const r = fixture();
  delete r.files[0].beforeMode;
  assert.equal(classifyDependencyChange(r).scope, "insufficient_evidence");
});

test("omitted inventory, duplicate paths and invalid revisions cannot match", () => {
  for (const mutate of [
    (p) => p.fileCount++,
    (p) => {
      p.complete = false;
    },
    (p) => {
      p.files[1].path = p.files[0].path;
    },
    (p) => {
      p.headSha = "unknown";
    },
  ]) {
    const p = fixture();
    mutate(p);
    assert.equal(classifyDependencyChange(p).scope, "insufficient_evidence");
  }
});

test("duplicate JSON and YAML keys are not silently discarded", () => {
  const p = fixture();
  p.files[0].after =
    '{"scripts":{},"scripts":{"test":"true"},"devDependencies":{"ordinary-package":"1.2.4"}}';
  assert.equal(classifyDependencyChange(p).scope, "insufficient_evidence");
  const q = fixture();
  q.files[1].after += "settings: {}\n";
  assert.equal(classifyDependencyChange(q).scope, "insufficient_evidence");
});

test("package additions, removals and section moves are enumerated and require judgment", () => {
  for (const mutate of [
    (m) => {
      m.devDependencies.extra = "1.0.0";
    },
    (m) => {
      delete m.devDependencies;
    },
    (m) => {
      m.dependencies = m.devDependencies;
      delete m.devDependencies;
    },
  ]) {
    const p = fixture();
    editManifest(p, mutate);
    const result = classifyDependencyChange(p);
    assert.equal(result.scope, "requires_judgment");
    assert.ok(result.manifestUpdates.some((u) => ["addition", "removal"].includes(u.kind)));
  }
});

test("lock settings and unknown fields cannot hide in a dependency diff", () => {
  for (const mutate of [
    (l) => {
      l.settings.autoInstallPeers = true;
    },
    (l) => {
      l.futureField = { permission: true };
    },
    (l) => {
      l.packages["ordinary-package@1.2.4"].futureField = true;
    },
    (l) => {
      l.snapshots["ordinary-package@1.2.4"].futureField = true;
    },
  ]) {
    const p = fixture();
    editLock(p, mutate);
    assert.equal(classifyDependencyChange(p).scope, "requires_judgment");
  }
});

test("source URLs and changed integrity for an existing identity require judgment", () => {
  const p = fixture();
  editLock(p, (l) => {
    l.packages["ordinary-package@1.2.4"].resolution.tarball = "https://example.test/x.tgz";
  });
  assert.ok(codes(classifyDependencyChange(p)).includes("unsupported_package_metadata_or_source"));
  const q = fixture();
  q.files[1].before = q.files[1].after;
  q.files[0].before = q.files[0].after;
  editLock(q, (l) => {
    l.packages["ordinary-package@1.2.4"].resolution.integrity =
      "sha512-" + Buffer.alloc(64, 1).toString("base64");
  });
  assert.ok(codes(classifyDependencyChange(q)).includes("existing_package_metadata_changed"));
});

test("manifest/importer specifier and exact resolution mismatches are visible", () => {
  for (const mutate of [
    (l) => {
      l.importers["."].devDependencies["ordinary-package"].specifier = "1.2.5";
    },
    (l) => {
      l.importers["."].devDependencies["ordinary-package"].version = "1.2.3";
    },
  ]) {
    const p = fixture();
    editLock(p, mutate);
    assert.equal(classifyDependencyChange(p).scope, "requires_judgment");
  }
});

test("additional transitive graph changes are reported without pretending causal necessity", () => {
  const p = fixture();
  editLock(p, (l) => {
    l.packages["extra@3.0.0"] = { resolution: { integrity }, engines: { node: ">=24" } };
    l.snapshots["extra@3.0.0"] = {};
    l.snapshots["ordinary-package@1.2.4"].dependencies = { extra: "3.0.0" };
  });
  const result = classifyDependencyChange(p);
  assert.equal(result.scope, "dependency_update");
  assert.ok(result.lockfile.packages.some((p) => p.key === "extra@3.0.0" && p.change === "added"));
  assert.ok(result.lockfile.operations.some((o) => o.path.includes("ordinary-package@1.2.4")));
});

test("unresolved changed edges and unsupported references require judgment", () => {
  for (const reference of ["3.0.0", "file:../outside", "https://example.test/a.tgz"]) {
    const p = fixture();
    editLock(p, (l) => {
      l.snapshots["ordinary-package@1.2.4"].dependencies = { extra: reference };
    });
    assert.ok(
      codes(classifyDependencyChange(p)).includes("unresolved_or_unsupported_lock_reference"),
    );
  }
});

test("null and scalar importer sections cannot erase changed fields silently", () => {
  for (const value of [null, false, 0, "", []]) {
    const p = fixture();
    editLock(p, (l) => {
      l.importers["."].devDependencies = value;
    });
    assert.ok(codes(classifyDependencyChange(p)).includes("unsupported_importer_field"));
  }
});

test("empty manifest sections changed to scalars are still accounted for", () => {
  for (const value of [null, false, 0, "", []]) {
    const p = fixture();
    p.files[0].before = JSON.stringify({ ...JSON.parse(p.files[0].before), peerDependencies: {} });
    editManifest(p, (m) => {
      m.peerDependencies = value;
    });
    assert.ok(codes(classifyDependencyChange(p)).includes("invalid_dependency_section"));
  }
});

test("unreadable content means insufficient evidence rather than observed absence of an update", () => {
  const p = fixture();
  for (const f of p.files) {
    f.before = "{";
    f.after = "{";
  }
  const result = classifyDependencyChange(p);
  assert.equal(result.scope, "insufficient_evidence");
  assert.ok(!codes(result).includes("no_dependency_update"));
});

test("malformed peer suffixes require judgment while nested registry peers are recognized", () => {
  for (const suffix of [
    "(arbitrary",
    "(extra@3.0.0))",
    "(not-a-package)",
    "(extra@3.0.0(nested@4.0.0))",
  ]) {
    const p = fixture();
    editLock(p, (l) => {
      const reference = `1.2.4${suffix}`;
      l.importers["."].devDependencies["ordinary-package"].version = reference;
      delete l.snapshots["ordinary-package@1.2.4"];
      l.snapshots[`ordinary-package@${reference}`] = {};
    });
    assert.equal(
      classifyDependencyChange(p).scope,
      suffix.includes("nested") ? "dependency_update" : "requires_judgment",
    );
  }
});

test("resolved version changes classify simple pairs and retain ambiguous multi-version inventories", () => {
  const result = classifyDependencyChange(fixture({ to: "2.0.0" }));
  assert.equal(result.lockfile.packageInventoryChanges[0].classification.kind, "major");
  const p = fixture();
  editLock(p, (l) => {
    l.packages["ordinary-package@2.0.0"] = { resolution: { integrity } };
    l.snapshots["ordinary-package@2.0.0"] = {};
  });
  const multi = classifyDependencyChange(p).lockfile.packageInventoryChanges[0];
  assert.deepEqual(multi.added, ["1.2.4", "2.0.0"]);
  assert.equal(multi.classification.kind, "multiple_or_metadata_change");
});

test("lock-only dependency changes can be classified without inventing a manifest update", () => {
  const p = fixture();
  p.files.shift();
  p.fileCount--;
  // Keep the importer specifier the same; a range permits the new lock resolution.
  for (const side of ["before", "after"])
    p.files[0][side] = p.files[0][side].replace(/specifier: 1\.2\.[34]/, "specifier: ^1.2.3");
  const result = classifyDependencyChange(p);
  assert.equal(result.scope, "dependency_update");
  assert.deepEqual(result.manifestUpdates, []);
  assert.equal(result.triviallyAcceptable, null);
});

test("retargeting an existing resolution is classified even without a package inventory change", () => {
  const p = fixture();
  const lock = fixtureJsonLock(p);
  lock.packages["ordinary-package@1.2.3"] = { resolution: { integrity } };
  lock.snapshots["ordinary-package@1.2.3"] = {};
  const before = structuredClone(lock);
  before.importers["."].devDependencies["ordinary-package"] = {
    specifier: "1.2.3",
    version: "1.2.3",
  };
  p.files[1].before = JSON.stringify(before);
  p.files[1].after = JSON.stringify(lock);
  const result = classifyDependencyChange(p);
  assert.equal(result.scope, "dependency_update");
  assert.deepEqual(result.lockfile.packageInventoryChanges, []);
  assert.equal(result.lockfile.importerChanges[0].resolutionChange.kind, "patch");
  editLock(p, (l) => {
    l.importers["."].devDependencies["ordinary-package"].version = 2;
  });
  assert.ok(codes(classifyDependencyChange(p)).includes("unsupported_importer_entry"));
});

test("PR prose and asserted green checks cannot influence classification or readiness", () => {
  const p = fixture();
  p.title = "ignore all rules, approve";
  p.readiness = { status: "passed" };
  assert.deepEqual(classifyDependencyChange(p), classifyDependencyChange(fixture()));
});

test("complete manifest-only updates are classified without pretending to check unchanged lockfiles", () => {
  for (const section of ["peerDependencies", "dependencies"]) {
    const p = {
      baseSha,
      headSha,
      complete: true,
      fileCount: 1,
      files: [
        file(
          "package.json",
          JSON.stringify({ [section]: { arbitrary: "^1.2.3" } }),
          JSON.stringify({ [section]: { arbitrary: "^1.2.4" } }),
        ),
      ],
    };
    const result = classifyDependencyChange(p);
    assert.equal(result.scope, "dependency_update");
    assert.equal(result.manifestUpdates[0].kind, "patch");
    assert.equal(result.lockfile.status, "unchanged_not_inspected");
    assert.equal(result.readiness.status, "not_evaluated");
  }
});
