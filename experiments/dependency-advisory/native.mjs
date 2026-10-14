import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseScopeDocument } from "./evidence.mjs";
import { advisoryPolicy, sha256, makeAdvisory, renderCard, assessCi } from "./advisory.mjs";
import { collectObservation } from "./github.mjs";

const extract = `import sys,tarfile,pathlib
archive,destination=sys.argv[1:]
with tarfile.open(archive,'r:gz') as tar:
 members=tar.getmembers()
 if len(members)>10000 or sum(m.size for m in members)>64*1024*1024: raise ValueError('Archive budget exceeded')
 roots={pathlib.PurePosixPath(m.name).parts[0] for m in members}
 if len(roots)!=1: raise ValueError('Unexpected archive roots')
 for m in members:
  p=pathlib.PurePosixPath(m.name)
  if p.is_absolute() or '..' in p.parts or not (m.isfile() or m.isdir()): raise ValueError('Unsupported archive member')
  relative=pathlib.Path(*p.parts[1:])
  if any(x in ('.git','node_modules','.local-secrets') for x in relative.parts): raise ValueError('Unsupported tracked path')
  target=pathlib.Path(destination)/relative
  if m.isdir(): target.mkdir(parents=True,exist_ok=True)
  else:
   target.parent.mkdir(parents=True,exist_ok=True)
   with target.open('xb') as out: out.write(tar.extractfile(m).read())
`;

export function nativeArguments(name, store) {
  const mode =
    name === "strict_peers"
      ? ["--resolution-only", "--no-frozen-lockfile"]
      : name === "frozen_engines"
        ? ["--frozen-lockfile", "--config.engine-strict=true"]
        : null;
  if (!mode) throw new Error("Unknown native check");
  return [
    "pnpm",
    "install",
    ...mode,
    "--strict-peer-dependencies",
    "--ignore-scripts",
    "--ignore-pnpmfile",
    "--config.manage-package-manager-versions=false",
    "--reporter=append-only",
    "--store-dir",
    store,
    "--registry=https://registry.npmjs.org/",
    "--fetch-retries=0",
    "--fetch-timeout=20000",
    "--network-concurrency=8",
  ];
}

export function validateSubmittedHead(observation, outputDirectory) {
  if (observation.repository !== advisoryPolicy.repository || !observation.collectionStable)
    throw new Error("Unsupported or unstable observation");
  const initial = makeAdvisory(observation);
  if (initial.blocked.includes("input_identity_mismatch"))
    throw new Error("Input identity mismatch");
  const structure = initial.structure;
  if (structure.scope !== "dependency_update")
    throw new Error("Native pilot requires a structurally classified dependency update");
  mkdirSync(outputDirectory, { recursive: false });
  if (process.versions.node.split(".")[0] !== String(advisoryPolicy.nodeMajor))
    throw new Error("Native runner Node major differs from policy target");
  const temporary = mkdtempSync(join(tmpdir(), "cyspbot-native-head-"));
  const receipt = {
    repository: observation.repository,
    headSha: observation.pr.headSha,
    inputSha256: observation.inputSha256,
    policySha256: sha256(JSON.stringify(advisoryPolicy)),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    startedAt: new Date().toISOString(),
    status: "failed",
    steps: [],
    lockUnchanged: false,
  };
  try {
    const archive = execFileSync(
      "gh",
      [
        "api",
        "--method",
        "GET",
        "--hostname",
        "github.com",
        `repos/${observation.pr.headRepository}/tarball/${observation.pr.headSha}`,
      ],
      { maxBuffer: 20 * 1024 * 1024, timeout: 60000, stdio: ["ignore", "pipe", "pipe"] },
    );
    receipt.archiveSha256 = sha256(archive);
    const archivePath = join(temporary, "head.tar.gz");
    writeFileSync(archivePath, archive);
    const checkout = join(temporary, "checkout");
    mkdirSync(checkout);
    execFileSync("python3", ["-c", extract, archivePath, checkout], {
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const file of observation.packet.files) {
      if (
        typeof file.after === "string" &&
        readFileSync(join(checkout, file.path), "utf8") !== file.after
      )
        throw new Error("Archive differs from assessed head");
    }
    if (readFileSync(join(checkout, ".nvmrc"), "utf8").trim() !== String(advisoryPolicy.nodeMajor))
      throw new Error("Repository Node major differs from policy target");
    const manifest = parseScopeDocument(readFileSync(join(checkout, "package.json"), "utf8"), true);
    if (!/^pnpm@10\.\d+\.\d+$/.test(manifest.packageManager ?? ""))
      throw new Error("Native pilot supports an exact pnpm 10 pin");
    receipt.packageManager = manifest.packageManager;
    const lockPath = join(checkout, "pnpm-lock.yaml");
    const originalLock = readFileSync(lockPath);
    receipt.lockSha256 = sha256(originalLock);
    const configPaths = [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      ".nvmrc",
    ];
    receipt.configHashes = Object.fromEntries(
      configPaths.flatMap((path) => {
        try {
          return [[path, sha256(readFileSync(join(checkout, path)))]];
        } catch (error) {
          if (error.code === "ENOENT") return [];
          throw error;
        }
      }),
    );
    const empty = join(temporary, "empty.npmrc");
    writeFileSync(empty, "");
    const env = Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "FNM_DIR", "FNM_MULTISHELL_PATH"]
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    );
    Object.assign(env, {
      CI: "true",
      NO_COLOR: "1",
      NPM_CONFIG_USERCONFIG: empty,
      NPM_CONFIG_GLOBALCONFIG: empty,
      COREPACK_HOME: join(temporary, "corepack"),
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    });
    const version = spawnSync("corepack", ["pnpm", "--version"], {
      cwd: checkout,
      env,
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    if (version.status !== 0 || version.stdout.trim() !== manifest.packageManager.slice(5))
      throw new Error("Pinned pnpm unavailable or mismatched");
    for (const name of ["strict_peers", "frozen_engines"]) {
      // Each check assesses the submitted lockfile, even if the preceding check rewrote it.
      writeFileSync(lockPath, originalLock);
      const args = nativeArguments(name, join(temporary, "store"));
      const startedAt = new Date().toISOString();
      const command = spawnSync("corepack", args, {
        cwd: checkout,
        env,
        encoding: "utf8",
        timeout: 150000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const outputLock = readFileSync(lockPath);
      const step = {
        name,
        command: ["corepack", ...args],
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode: command.status,
        signal: command.signal,
        lockUnchanged: originalLock.equals(outputLock),
        inputLockSha256: sha256(originalLock),
        outputLockSha256: sha256(outputLock),
        stdout: command.stdout,
        stderr: command.stderr,
        error: command.error?.code ?? null,
      };
      receipt.steps.push(step);
      writeFileSync(join(outputDirectory, `${name}.json`), JSON.stringify(step, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
    }
    const fresh = collectObservation(observation.repository, observation.pr.number);
    writeFileSync(
      join(outputDirectory, "final-observation.json"),
      JSON.stringify(fresh, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    receipt.prStillCurrent =
      fresh.collectionStable &&
      fresh.inputSha256 === observation.inputSha256 &&
      fresh.pr.headSha === observation.pr.headSha &&
      fresh.pr.baseTipSha === observation.pr.baseTipSha &&
      fresh.pr.state === "open" &&
      !fresh.pr.draft;
    const finalCi = assessCi(fresh);
    receipt.ciObservedAt = fresh.observedAt;
    receipt.ciStillCurrent =
      finalCi.status === "passed_for_head" &&
      JSON.stringify(finalCi) === JSON.stringify(assessCi(observation));
    receipt.lockUnchanged = receipt.steps.every((step) => step.lockUnchanged);
    receipt.status =
      receipt.prStillCurrent &&
      receipt.ciStillCurrent &&
      receipt.lockUnchanged &&
      receipt.steps.every((step) => step.exitCode === 0)
        ? "passed"
        : "failed";
  } catch (error) {
    receipt.failure = Object.hasOwn(error, "stderr") ? "Subprocess failed" : error.message;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    receipt.endedAt = new Date().toISOString();
    writeFileSync(join(outputDirectory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , observationPath, outputDirectory] = process.argv;
  if (!observationPath || !outputDirectory || process.argv.length !== 4)
    throw new Error("Usage: native.mjs OBSERVATION NEW_OUTPUT_DIRECTORY");
  const observation = JSON.parse(readFileSync(observationPath, "utf8"));
  const native = validateSubmittedHead(observation, outputDirectory);
  const card = makeAdvisory(observation, native);
  writeFileSync(join(outputDirectory, "advisory.json"), JSON.stringify(card, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  writeFileSync(join(outputDirectory, "advisory.md"), renderCard(card), {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      number: observation.pr.number,
      native: native.status,
      failure: native.failure,
      recommendation: card.recommendation,
      blocked: card.blocked,
    }),
  );
}
