import { isDeepStrictEqual } from "node:util";
import { parseScopeDocument, semanticOperations } from "./evidence.mjs";

const policyVersion = "dependency-structure-v1";
const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const lockSections = sections.filter((section) => section !== "peerDependencies");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value) =>
  object(value) && Object.values(value).every((item) => typeof item === "string");
const stringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const keys = (a, b) =>
  [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort((a, b) =>
    a.localeCompare(b),
  );
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/;

function version(value) {
  const match = typeof value === "string" && versionPattern.exec(value);
  if (!match || match[4]?.split(".").some((part) => /^0\d+$/.test(part))) return null;
  return { parts: match.slice(1, 4).map(BigInt), prerelease: match[4], build: match[5] };
}

export function classifyVersionChange(from, to) {
  const parse = (value) => {
    const operator = typeof value === "string" && /^[~^]/.test(value) ? value[0] : "";
    return { operator, value: version(operator ? value.slice(1) : value) };
  };
  const a = parse(from);
  const b = parse(to);
  const result = { kind: "other_specifier_change", versionZero: false, range: false };
  if (!a.value || !b.value) return result;
  result.versionZero = a.value.parts[0] === 0n || b.value.parts[0] === 0n;
  result.range = Boolean(a.operator || b.operator);
  if (a.operator !== b.operator) return { ...result, kind: "range_operator_change" };
  if (a.value.prerelease || b.value.prerelease) return { ...result, kind: "prerelease" };
  const part = a.value.parts.findIndex((n, i) => n !== b.value.parts[i]);
  if (part < 0) return { ...result, kind: from === to ? "unchanged" : "build_metadata" };
  return {
    ...result,
    kind:
      a.value.parts[part] > b.value.parts[part] ? "downgrade" : ["major", "minor", "patch"][part],
  };
}

function packageIdentity(key, depth = 0) {
  if (typeof key !== "string" || depth > 32) return null;
  const bare = key.split("(")[0];
  const at = bare.lastIndexOf("@");
  if (at <= 0 || !version(bare.slice(at + 1))) return null;
  const name = bare.slice(0, at);
  if (!/^(?:@[a-z\d._~-]+\/)?[a-z\d._~-]+$/i.test(name)) return null;
  let offset = bare.length;
  while (offset < key.length) {
    if (key[offset] !== "(") return null;
    let balance = 1;
    let end = offset + 1;
    while (end < key.length && balance) {
      if (key[end] === "(") balance++;
      if (key[end] === ")") balance--;
      end++;
    }
    if (balance || !packageIdentity(key.slice(offset + 1, end - 1), depth + 1)) return null;
    offset = end;
  }
  return { name, version: bare.slice(at + 1), bare };
}

function packageRecord(value) {
  if (!object(value)) return false;
  const validators = {
    resolution: (entry) =>
      object(entry) &&
      Object.keys(entry).length === 1 &&
      typeof entry.integrity === "string" &&
      /^sha(?:256|384|512)-[A-Za-z\d+/]+={0,2}$/.test(entry.integrity),
    engines: strings,
    cpu: stringArray,
    os: stringArray,
    libc: stringArray,
    deprecated: (entry) => typeof entry === "string",
    hasBin: (entry) => typeof entry === "boolean",
    peerDependencies: strings,
    peerDependenciesMeta: (entry) =>
      object(entry) &&
      Object.values(entry).every(
        (meta) =>
          object(meta) &&
          Object.keys(meta).every((key) => key === "optional") &&
          typeof meta.optional === "boolean",
      ),
  };
  return (
    own(value, "resolution") &&
    Object.entries(value).every(
      ([key, entry]) => Object.hasOwn(validators, key) && validators[key](entry),
    )
  );
}

function snapshotRecord(value) {
  if (!object(value)) return false;
  return Object.entries(value).every(([key, entry]) => {
    if (["dependencies", "optionalDependencies"].includes(key)) return strings(entry);
    if (key === "transitivePeerDependencies") return stringArray(entry);
    if (key === "optional") return typeof entry === "boolean";
    return false;
  });
}

function manifestPath(path) {
  return (
    typeof path === "string" &&
    /^(?:[^/\\]+\/)*package\.json$/.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..")
  );
}

// Input is a complete, revision-bound packet from a trusted collector. No source code runs here.
export function classifyDependencyChange(packet) {
  const result = {
    policyVersion,
    baseSha: packet.baseSha,
    headSha: packet.headSha,
    scope: "insufficient_evidence",
    findings: [],
    manifestUpdates: [],
    lockfile: {
      status: "unchanged_not_inspected",
      operations: [],
      importerChanges: [],
      packages: [],
      packageInventoryChanges: [],
      snapshots: [],
    },
    readiness: { status: "not_evaluated" },
    triviallyAcceptable: null,
    limits: [
      "No reconstruction or causal-minimality proof.",
      "No registry metadata authentication or release-safety assessment.",
    ],
  };
  const finding = (code, file, path = [], severity = "requires_judgment") => {
    result.findings.push({ code, file, path, severity });
  };
  if (
    !/^[a-f\d]{40}$/.test(packet.baseSha ?? "") ||
    !/^[a-f\d]{40}$/.test(packet.headSha ?? "") ||
    packet.complete !== true ||
    !Array.isArray(packet.files) ||
    packet.files.length === 0 ||
    packet.fileCount !== packet.files.length ||
    new Set(packet.files.map((file) => file.path)).size !== packet.files.length
  ) {
    finding("incomplete_inventory", null, [], "insufficient_evidence");
    return result;
  }
  const manifests = new Map();
  let lock;
  for (const file of packet.files) {
    if (file.status !== "modified") finding("file_added_removed_or_renamed", file.path);
    if (file.beforeMode === undefined || file.afterMode === undefined) {
      finding("missing_file_modes", file.path, [], "insufficient_evidence");
    } else if (file.beforeMode !== "100644" || file.afterMode !== "100644") {
      finding("file_mode_outside_policy", file.path);
    }
    if (!manifestPath(file.path) && file.path !== "pnpm-lock.yaml") {
      finding("non_dependency_file", file.path);
      continue;
    }
    try {
      const json = file.path !== "pnpm-lock.yaml";
      const before = parseScopeDocument(file.before, json);
      const after = parseScopeDocument(file.after, json);
      if (!json) {
        lock = { before, after };
        continue;
      }
      manifests.set(file.path, { before, after });
      for (const operation of semanticOperations(file.path, before, after)) {
        const [section, name] = operation.path;
        if (!sections.includes(section)) {
          finding("non_dependency_manifest_change", file.path, operation.path);
          continue;
        }
        if (
          operation.path.length === 1 &&
          [operation.before, operation.after].some((value) => value !== undefined && !object(value))
        ) {
          finding("invalid_dependency_section", file.path, operation.path);
          continue;
        }
        // Expand whole-section additions/removals so every dependency stays visible.
        const entries =
          operation.path.length === 1 && (object(operation.before) || object(operation.after))
            ? keys(operation.before, operation.after).map((key) => ({
                name: key,
                from: operation.before?.[key],
                to: operation.after?.[key],
              }))
            : [{ name, from: operation.before, to: operation.after }];
        for (const entry of entries) {
          const change =
            entry.from === undefined
              ? { kind: "addition" }
              : entry.to === undefined
                ? { kind: "removal" }
                : classifyVersionChange(entry.from, entry.to);
          result.manifestUpdates.push({ file: file.path, section, ...entry, ...change });
          if (
            operation.path.length > 2 ||
            typeof entry.name !== "string" ||
            typeof entry.from !== "string" ||
            typeof entry.to !== "string" ||
            ["other_specifier_change", "range_operator_change"].includes(change.kind)
          ) {
            finding("dependency_operation_outside_version_update", file.path, [
              section,
              entry.name ?? "",
            ]);
          }
        }
      }
    } catch {
      finding("missing_invalid_or_ambiguous_document", file.path, [], "insufficient_evidence");
    }
  }
  if (lock) {
    result.lockfile.status = "inspected";
    inspectLock(lock, manifests, result, finding);
  } else if (packet.files.some((file) => file.path === "pnpm-lock.yaml")) {
    result.lockfile.status = "unavailable";
  }
  if (
    !result.manifestUpdates.length &&
    !result.lockfile.operations.length &&
    !result.findings.some((item) => item.severity === "insufficient_evidence")
  )
    finding("no_dependency_update", null);
  result.scope = result.findings.some((item) => item.severity === "requires_judgment")
    ? "requires_judgment"
    : result.findings.length
      ? "insufficient_evidence"
      : "dependency_update";
  return result;
}

function inspectLock({ before, after }, manifests, result, finding) {
  const file = "pnpm-lock.yaml";
  const operations = semanticOperations(file, before, after);
  result.lockfile.operations = operations;
  if (String(before.lockfileVersion) !== "9.0" || String(after.lockfileVersion) !== "9.0") {
    finding("unsupported_lockfile_version", file, ["lockfileVersion"], "insufficient_evidence");
    return;
  }
  for (const field of ["importers", "packages", "snapshots"]) {
    if (!object(before[field]) || !object(after[field])) {
      finding("unsupported_lockfile_structure", file, [field], "insufficient_evidence");
      return;
    }
  }
  for (const field of keys(before, after)) {
    if (
      !["importers", "packages", "snapshots"].includes(field) &&
      !isDeepStrictEqual(before[field], after[field])
    )
      finding("lockfile_configuration_change", file, [field]);
  }
  for (const importer of keys(before.importers, after.importers)) {
    const a = before.importers[importer];
    const b = after.importers[importer];
    if (isDeepStrictEqual(a, b)) continue;
    if (!object(a) || !object(b)) {
      finding("importer_added_or_removed", file, ["importers", importer]);
      continue;
    }
    for (const section of keys(a, b)) {
      if (isDeepStrictEqual(a[section], b[section])) continue;
      if (
        !lockSections.includes(section) ||
        (own(a, section) && !object(a[section])) ||
        (own(b, section) && !object(b[section]))
      ) {
        finding("unsupported_importer_field", file, ["importers", importer, section]);
        continue;
      }
      for (const name of keys(a[section], b[section])) {
        const left = a[section]?.[name];
        const right = b[section]?.[name];
        if (isDeepStrictEqual(left, right)) continue;
        const path = ["importers", importer, section, name];
        const leftVersion =
          typeof left?.version === "string" ? left.version.split("(")[0] : undefined;
        const rightVersion =
          typeof right?.version === "string" ? right.version.split("(")[0] : undefined;
        result.lockfile.importerChanges.push({
          importer,
          section,
          name,
          before: left,
          after: right,
          resolutionChange:
            left?.version === right?.version
              ? { kind: "unchanged" }
              : leftVersion !== undefined && leftVersion === rightVersion
                ? { kind: "peer_context_change" }
                : classifyVersionChange(leftVersion, rightVersion),
        });
        const valid = (entry) =>
          object(entry) &&
          keys(entry, {}).every((key) => ["specifier", "version"].includes(key)) &&
          typeof entry.specifier === "string" &&
          typeof entry.version === "string";
        if (!valid(left) || !valid(right)) {
          finding("unsupported_importer_entry", file, path);
          continue;
        }
        const manifestFile = importer === "." ? "package.json" : `${importer}/package.json`;
        const manifest = manifests.get(manifestFile);
        if (
          left.specifier !== right.specifier &&
          (!manifest ||
            manifest.before[section]?.[name] !== left.specifier ||
            manifest.after[section]?.[name] !== right.specifier)
        ) {
          const unavailable = result.findings.some(
            (item) =>
              item.file === manifestFile && item.code === "missing_invalid_or_ambiguous_document",
          );
          finding(
            "unmatched_importer_specifier",
            file,
            path,
            unavailable ? "insufficient_evidence" : "requires_judgment",
          );
        }
        for (const [entry, document] of [
          [left, before],
          [right, after],
        ]) {
          if (version(entry.specifier) && entry.version.split("(")[0] !== entry.specifier)
            finding("exact_version_mismatch", file, path);
          checkReference(name, entry.version, document, file, path, finding);
        }
      }
    }
  }
  for (const update of result.manifestUpdates) {
    if (!lockSections.includes(update.section)) continue; // Peer declarations have no universal importer mapping.
    const importer =
      update.file === "package.json" ? "." : update.file.slice(0, -"/package.json".length);
    if (
      before.importers[importer]?.[update.section]?.[update.name]?.specifier !== update.from ||
      after.importers[importer]?.[update.section]?.[update.name]?.specifier !== update.to
    ) {
      finding("manifest_lock_specifier_mismatch", file, [
        "importers",
        importer,
        update.section,
        update.name,
      ]);
    }
  }
  for (const key of keys(before.packages, after.packages)) {
    const a = before.packages[key];
    const b = after.packages[key];
    if (isDeepStrictEqual(a, b)) continue;
    result.lockfile.packages.push({
      key,
      identity: packageIdentity(key),
      change: !own(before.packages, key)
        ? "added"
        : !own(after.packages, key)
          ? "removed"
          : "modified",
    });
    if (own(before.packages, key) && own(after.packages, key))
      finding("existing_package_metadata_changed", file, ["packages", key]);
    if (
      !packageIdentity(key) ||
      key.includes("(") ||
      [a, b].filter((entry) => entry !== undefined).some((entry) => !packageRecord(entry))
    ) {
      finding("unsupported_package_metadata_or_source", file, ["packages", key]);
    }
  }
  for (const key of keys(before.snapshots, after.snapshots)) {
    const a = before.snapshots[key];
    const b = after.snapshots[key];
    if (isDeepStrictEqual(a, b)) continue;
    result.lockfile.snapshots.push({
      key,
      change: !own(before.snapshots, key)
        ? "added"
        : !own(after.snapshots, key)
          ? "removed"
          : "modified",
    });
    for (const [entry, document] of [
      [a, before],
      [b, after],
    ]) {
      if (entry === undefined) continue;
      const identity = packageIdentity(key);
      if (!identity || !own(document.packages, identity.bare) || !snapshotRecord(entry)) {
        finding("unsupported_snapshot", file, ["snapshots", key]);
        continue;
      }
      for (const section of ["dependencies", "optionalDependencies"]) {
        for (const [name, reference] of Object.entries(entry[section] ?? {}))
          checkReference(
            name,
            reference,
            document,
            file,
            ["snapshots", key, section, name],
            finding,
          );
      }
    }
  }
  const names = [
    ...new Set(result.lockfile.packages.map((entry) => entry.identity?.name).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const versions = (document) =>
      Object.keys(document.packages)
        .map((key) => packageIdentity(key))
        .filter((identity) => identity?.name === name)
        .map((identity) => identity.version)
        .sort((a, b) => a.localeCompare(b));
    const oldVersions = versions(before);
    const newVersions = versions(after);
    const removed = oldVersions.filter((v) => !newVersions.includes(v));
    const added = newVersions.filter((v) => !oldVersions.includes(v));
    result.lockfile.packageInventoryChanges.push({
      name,
      before: oldVersions,
      after: newVersions,
      removed,
      added,
      classification:
        removed.length === 1 && added.length === 1
          ? classifyVersionChange(removed[0], added[0])
          : {
              kind:
                added.length && !removed.length
                  ? "addition"
                  : removed.length && !added.length
                    ? "removal"
                    : "multiple_or_metadata_change",
            },
    });
  }
}

function checkReference(name, reference, lock, file, path, finding) {
  const key = `${name}@${reference}`;
  const identity = packageIdentity(key);
  if (!identity || !own(lock.snapshots, key) || !own(lock.packages, identity.bare)) {
    finding("unresolved_or_unsupported_lock_reference", file, path);
  }
}
