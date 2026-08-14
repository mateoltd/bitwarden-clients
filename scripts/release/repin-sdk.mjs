import fs from "node:fs";
import path from "node:path";

import {
  assert,
  hashFile,
  parseArgs,
  readJson,
  readManifest,
  repositoryRoot,
  requireString,
  run,
  sha512Integrity,
  tarText,
  writeJson,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const candidateDirectory = path.resolve(
  repositoryRoot,
  requireString(args.candidate, "--candidate is required"),
);
const sourceCommit = requireString(args["source-commit"], "--source-commit is required");
assert(/^[0-9a-f]{40}$/.test(sourceCommit), "--source-commit must be a full lowercase Git commit");
const workflowRunId = Number(requireString(args["workflow-run"], "--workflow-run is required"));
const artifactId = Number(requireString(args["artifact-id"], "--artifact-id is required"));
const artifactName = requireString(args["artifact-name"], "--artifact-name is required");
const artifactZipSha256 = requireString(
  args["artifact-zip-sha256"],
  "--artifact-zip-sha256 is required",
);
assert(
  Number.isSafeInteger(workflowRunId) && Number.isSafeInteger(artifactId),
  "workflow and artifact IDs must be integers",
);
assert(/^[0-9a-f]{64}$/.test(artifactZipSha256), "artifact ZIP SHA-256 is invalid");
assert(
  artifactName === `alias-sdk-release-candidate-${sourceCommit}`,
  "artifact name does not match the source commit",
);

function resolveCandidate(relative) {
  assert(
    typeof relative === "string" &&
      relative.length > 0 &&
      !path.isAbsolute(relative) &&
      !relative.includes("\\"),
    `Unsafe candidate path: ${relative}`,
  );
  const resolved = path.resolve(candidateDirectory, relative);
  assert(
    resolved.startsWith(`${candidateDirectory}${path.sep}`),
    `Candidate path escapes its root: ${relative}`,
  );
  return resolved;
}

function candidateArtifact(relative) {
  assert(
    typeof relative === "string" &&
      relative === path.posix.normalize(relative) &&
      relative !== ".." &&
      !relative.startsWith("../") &&
      !relative.includes("\0"),
    `Unsafe SDK artifact path: ${relative}`,
  );
  return resolveCandidate(path.posix.join("artifacts", relative));
}

function parseSums(file) {
  const entries = new Map();
  for (const line of fs.readFileSync(file, "utf8").trim().split("\n")) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    assert(match, `Invalid SDK checksum line: ${line}`);
    assert(!entries.has(match[2]), `Duplicate SDK checksum path: ${match[2]}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

assert(
  fs.statSync(candidateDirectory, { throwIfNoEntry: false })?.isDirectory(),
  "SDK candidate directory is missing",
);
const provenanceFile = resolveCandidate("handoff-manifest.json");
const sumsFile = resolveCandidate("SHA256SUMS");
assert(
  fs.statSync(provenanceFile, { throwIfNoEntry: false })?.isFile(),
  "SDK handoff manifest is missing",
);
assert(fs.statSync(sumsFile, { throwIfNoEntry: false })?.isFile(), "SDK SHA256SUMS is missing");

const provenance = readJson(provenanceFile);
assert(provenance.schemaVersion === 2, "Unsupported SDK handoff manifest schema");
assert(
  provenance.sourceCommit === sourceCommit,
  "SDK handoff source commit does not match --source-commit",
);
assert(
  typeof provenance.releaseVersion === "string" && provenance.releaseVersion.length > 0,
  "SDK handoff release version is missing",
);
assert(Array.isArray(provenance.artifacts), "SDK handoff artifact inventory is missing");

const sums = parseSums(sumsFile);
assert(sums.size === provenance.artifacts.length, "SDK checksum and artifact inventories differ");
const artifactPaths = new Set();
for (const entry of provenance.artifacts) {
  assert(!artifactPaths.has(entry.path), `Duplicate SDK artifact path: ${entry.path}`);
  artifactPaths.add(entry.path);
  assert(/^[0-9a-f]{64}$/.test(entry.sha256), `Invalid handoff digest for ${entry.path}`);
  const file = candidateArtifact(entry.path);
  assert(
    fs.statSync(file, { throwIfNoEntry: false })?.isFile(),
    `SDK candidate file is missing: ${entry.path}`,
  );
  assert(fs.statSync(file).size === entry.bytes, `SDK candidate size differs: ${entry.path}`);
  assert(hashFile(file) === entry.sha256, `SDK candidate digest differs: ${entry.path}`);
  assert(sums.get(entry.path) === entry.sha256, `SDK SHA256SUMS differs: ${entry.path}`);
}

const packageRecord = provenance.packages?.typescriptWasm;
assert(packageRecord?.name === "@bitwarden/sdk-internal", "SDK handoff package name changed");
assert(packageRecord?.format === "npm-tarball", "SDK handoff package format changed");
assert(packageRecord?.version === provenance.releaseVersion, "SDK handoff package version differs");
assert(
  provenance.artifacts.some(
    (entry) =>
      entry.path === packageRecord.artifact?.path &&
      entry.bytes === packageRecord.artifact?.bytes &&
      entry.sha256 === packageRecord.artifact?.sha256,
  ),
  "SDK package is not in the handoff artifact inventory",
);

const artifact = candidateArtifact(packageRecord.artifact.path);
const packageDirectory = path.posix.dirname(packageRecord.artifact.path);
const versionFile = candidateArtifact(path.posix.join(packageDirectory, "VERSION"));
const packageVersionFile = candidateArtifact(path.posix.join(packageDirectory, "PACKAGE_VERSION"));
const buildEnvironmentFile = candidateArtifact(
  path.posix.join(packageDirectory, "BUILD-ENVIRONMENT.txt"),
);
assert(
  fs.readFileSync(versionFile, "utf8").trim() === sourceCommit,
  "Published SDK VERSION differs",
);
assert(
  fs.readFileSync(packageVersionFile, "utf8").trim() === provenance.releaseVersion,
  "Published SDK PACKAGE_VERSION differs",
);
assert(
  fs.readFileSync(buildEnvironmentFile, "utf8").includes(`source_commit=${sourceCommit}`),
  "Published SDK build environment lacks the exact source commit",
);

const embeddedPackage = JSON.parse(tarText(artifact, "package/package.json"));
const embeddedCommit = tarText(artifact, "package/VERSION");
assert(embeddedPackage.name === packageRecord.name, "Unexpected embedded SDK package name");
assert(embeddedPackage.version === packageRecord.version, "Embedded SDK package version differs");
assert(embeddedCommit === sourceCommit, "Embedded SDK VERSION does not match --source-commit");

const version = embeddedPackage.version;
const sha256 = hashFile(artifact);
const integrity = sha512Integrity(artifact);
const provenanceSha256 = hashFile(provenanceFile);
const candidateChecksumsSha256 = hashFile(sumsFile);
assert(sha256 === packageRecord.artifact.sha256, "Published SDK package digest differs");

const manifest = readManifest();
if (args.check) {
  const sdk = manifest.canonicalSdk;
  assert(version === sdk.version, "Checked artifact version differs from the release manifest");
  assert(
    sourceCommit === sdk.sourceCommit,
    "Checked source commit differs from the release manifest",
  );
  assert(sha256 === sdk.sha256, "Checked artifact SHA-256 differs from the release manifest");
  assert(
    integrity === sdk.integrity,
    "Checked artifact integrity differs from the release manifest",
  );
  assert(
    provenanceSha256 === sdk.provenanceSha256,
    "Checked handoff provenance differs from the release manifest",
  );
  assert(
    candidateChecksumsSha256 === sdk.candidateChecksumsSha256,
    "Checked candidate checksum index differs from the release manifest",
  );
  assert(workflowRunId === sdk.workflow.runId, "Checked workflow run differs");
  assert(artifactId === sdk.workflow.artifactId, "Checked artifact ID differs");
  assert(artifactName === sdk.workflow.artifactName, "Checked artifact name differs");
  assert(
    artifactZipSha256 === sdk.workflow.artifactZipSha256,
    "Checked artifact ZIP digest differs",
  );
  run(process.execPath, ["scripts/release/verify-sdk.mjs"]);
  run(process.execPath, ["scripts/release/scope-audit.mjs"]);
  console.log(`Current SDK pin is valid: ${version} ${sha256}`);
  process.exit(0);
}

const oldSdk = { ...manifest.canonicalSdk };
const fileName = `bitwarden-sdk-internal-${version}.tgz`;
const relativeArtifact = `vendor/${fileName}`;
const relativeMetadata = `vendor/${fileName.replace(/\.tgz$/, ".md")}`;
const relativeProvenance = `vendor/${fileName.replace(/\.tgz$/, ".handoff.json")}`;
const relativeChecksums = `vendor/${fileName.replace(/\.tgz$/, ".candidate.SHA256SUMS")}`;
const relativeBuildEnvironment = `vendor/${fileName.replace(/\.tgz$/, ".build-environment.txt")}`;
fs.copyFileSync(artifact, path.join(repositoryRoot, relativeArtifact));
fs.copyFileSync(provenanceFile, path.join(repositoryRoot, relativeProvenance));
fs.copyFileSync(sumsFile, path.join(repositoryRoot, relativeChecksums));
fs.copyFileSync(buildEnvironmentFile, path.join(repositoryRoot, relativeBuildEnvironment));

Object.assign(manifest.canonicalSdk, {
  version,
  artifact: relativeArtifact,
  metadata: relativeMetadata,
  provenance: relativeProvenance,
  provenanceSha256,
  candidateChecksums: relativeChecksums,
  candidateChecksumsSha256,
  buildEnvironment: relativeBuildEnvironment,
  sha256,
  integrity,
  sourceCommit,
  aliasReferenceSchemaVersion: provenance.aliasReferenceSchemaVersion,
  workflow: {
    runId: workflowRunId,
    url: `${manifest.canonicalSdk.sourceRepository.replace(/\.git$/, "")}/actions/runs/${workflowRunId}`,
    conclusion: "success",
    artifactId,
    artifactName,
    artifactZipSha256,
  },
});
writeJson(path.join(repositoryRoot, "release/alias-client-release.json"), manifest);

const rootPackage = readJson(path.join(repositoryRoot, "package.json"));
const installedPackageNames = [embeddedPackage.name, "@bitwarden/alias-sdk-internal"];
for (const packageName of installedPackageNames) {
  rootPackage.dependencies[packageName] = `file:${relativeArtifact}`;
}
writeJson(path.join(repositoryRoot, "package.json"), rootPackage);

fs.writeFileSync(
  path.join(repositoryRoot, relativeMetadata),
  [
    `# Canonical SDK ${version}`,
    "",
    `- Package: \`${embeddedPackage.name}\``,
    `- Source repository: ${manifest.canonicalSdk.sourceRepository}`,
    `- Public ref: \`${manifest.canonicalSdk.publicRef}\``,
    `- Source commit: \`${sourceCommit}\``,
    `- Alias reference schema: \`${provenance.aliasReferenceSchemaVersion}\``,
    `- Workflow run: \`${workflowRunId}\``,
    `- Workflow URL: ${manifest.canonicalSdk.workflow.url}`,
    `- Artifact: \`${artifactName}\` (\`${artifactId}\`)`,
    `- Artifact ZIP SHA-256: \`${artifactZipSha256}\``,
    `- SHA-256: \`${sha256}\``,
    `- npm integrity: \`${integrity}\``,
    `- Published handoff manifest: \`${relativeProvenance}\``,
    `- Handoff manifest SHA-256: \`${provenanceSha256}\``,
    `- Published checksum index: \`${relativeChecksums}\``,
    `- Checksum index SHA-256: \`${candidateChecksumsSha256}\``,
    "",
    "This archive is an explicit, checksum-enforced build input for the public OSS clients.",
    "",
  ].join("\n"),
);

const npmVersion = run("npm", ["--version"], { capture: true });
assert(
  npmVersion === manifest.toolchains.npm,
  `npm ${manifest.toolchains.npm} is required; found ${npmVersion}`,
);

// npm retains the previous integrity when a local tarball is replaced without
// changing its version or path. Remove only this package's generated lock entry
// so the exact candidate bytes are re-read during lockfile regeneration.
const lockPath = path.join(repositoryRoot, "package-lock.json");
const lock = readJson(lockPath);
for (const packageName of installedPackageNames) {
  delete lock.packages?.[`node_modules/${packageName}`];
}
writeJson(lockPath, lock);
run("npm", ["install", "--package-lock-only", "--ignore-scripts"]);

for (const oldPath of [
  oldSdk.artifact,
  oldSdk.metadata,
  oldSdk.provenance,
  oldSdk.candidateChecksums,
  oldSdk.buildEnvironment,
]) {
  if (
    typeof oldPath !== "string" ||
    [
      relativeArtifact,
      relativeMetadata,
      relativeProvenance,
      relativeChecksums,
      relativeBuildEnvironment,
    ].includes(oldPath)
  )
    continue;
  const absolute = path.join(repositoryRoot, oldPath);
  if (absolute.startsWith(`${path.join(repositoryRoot, "vendor")}${path.sep}`))
    fs.rmSync(absolute, { force: true });
}

run(process.execPath, ["scripts/release/verify-sdk.mjs"]);
run(process.execPath, ["scripts/release/scope-audit.mjs"]);
console.log(`Repinned canonical SDK to ${sourceCommit} (${sha256})`);
