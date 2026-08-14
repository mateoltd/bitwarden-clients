import fs from "node:fs";
import path from "node:path";

import {
  assert,
  hashFile,
  readJson,
  readManifest,
  repositoryRoot,
  sha512Integrity,
  tarText,
} from "./lib.mjs";

const manifest = readManifest();
const sdk = manifest.canonicalSdk;
const artifact = path.join(repositoryRoot, sdk.artifact);
const provenanceFile = path.join(repositoryRoot, sdk.provenance);
const candidateChecksumsFile = path.join(repositoryRoot, sdk.candidateChecksums);
const buildEnvironmentFile = path.join(repositoryRoot, sdk.buildEnvironment);
const packageJson = readJson(path.join(repositoryRoot, "package.json"));
const packageLock = readJson(path.join(repositoryRoot, "package-lock.json"));

assert(fs.existsSync(artifact), `Pinned SDK artifact is missing: ${sdk.artifact}`);
assert(fs.existsSync(provenanceFile), `Pinned SDK provenance is missing: ${sdk.provenance}`);
assert(
  fs.existsSync(candidateChecksumsFile),
  `Pinned SDK checksum index is missing: ${sdk.candidateChecksums}`,
);
assert(
  fs.existsSync(buildEnvironmentFile),
  `Pinned SDK build environment is missing: ${sdk.buildEnvironment}`,
);
assert(hashFile(artifact) === sdk.sha256, "Pinned SDK SHA-256 does not match the manifest");
assert(
  hashFile(provenanceFile) === sdk.provenanceSha256,
  "Pinned SDK provenance SHA-256 does not match the manifest",
);
assert(
  hashFile(candidateChecksumsFile) === sdk.candidateChecksumsSha256,
  "Pinned SDK checksum index SHA-256 does not match the manifest",
);
assert(
  sha512Integrity(artifact) === sdk.integrity,
  "Pinned SDK npm integrity does not match the manifest",
);

const embeddedPackage = JSON.parse(tarText(artifact, "package/package.json"));
const embeddedCommit = tarText(artifact, "package/VERSION");
assert(
  embeddedPackage.name === sdk.package,
  `Unexpected SDK package name: ${embeddedPackage.name}`,
);
assert(embeddedPackage.version === sdk.version, "Embedded SDK version does not match the manifest");
assert(
  embeddedCommit === sdk.sourceCommit,
  "Embedded SDK source commit does not match the manifest",
);

const provenance = readJson(provenanceFile);
assert(provenance.schemaVersion === 2, "Unsupported SDK handoff manifest schema");
assert(provenance.sourceCommit === sdk.sourceCommit, "SDK provenance source commit differs");
assert(
  provenance.aliasReferenceSchemaVersion === sdk.aliasReferenceSchemaVersion &&
    sdk.aliasReferenceSchemaVersion === 1,
  "SDK alias reference schema is not public v1",
);
assert(provenance.releaseVersion === sdk.version, "SDK provenance release version differs");
const packageRecord = provenance.packages?.typescriptWasm;
assert(packageRecord?.name === sdk.package, "SDK provenance package name differs");
assert(packageRecord?.version === sdk.version, "SDK provenance package version differs");
assert(
  packageRecord?.aliasReferenceSchemaVersion === sdk.aliasReferenceSchemaVersion,
  "SDK package alias reference schema differs",
);
assert(packageRecord?.format === "npm-tarball", "SDK provenance package format differs");
assert(packageRecord?.artifact?.sha256 === sdk.sha256, "SDK provenance package digest differs");
assert(
  packageRecord?.artifact?.bytes === fs.statSync(artifact).size,
  "SDK provenance package size differs",
);
const checksumLines = fs.readFileSync(candidateChecksumsFile, "utf8").trim().split("\n");
const checksums = new Map(
  checksumLines.map((line) => {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    assert(match, `Invalid SDK checksum line: ${line}`);
    return [match[2], match[1]];
  }),
);
assert(checksums.size === provenance.artifacts.length, "SDK artifact inventories differ");
for (const entry of provenance.artifacts) {
  assert(checksums.get(entry.path) === entry.sha256, `SDK checksum differs: ${entry.path}`);
}
const checksumLine = `${sdk.sha256}  ${packageRecord.artifact.path}`;
assert(
  checksumLines.includes(checksumLine),
  "SDK candidate checksum index does not contain the pinned package",
);
assert(
  fs.readFileSync(buildEnvironmentFile, "utf8").includes(`source_commit=${sdk.sourceCommit}`),
  "SDK build environment source commit differs",
);

const dependency = `file:${sdk.artifact}`;
for (const packageName of [sdk.package, "@bitwarden/alias-sdk-internal"]) {
  assert(
    packageJson.dependencies[packageName] === dependency,
    `${packageName} does not consume the checksum-pinned SDK artifact`,
  );
  assert(
    packageLock.packages[""].dependencies[packageName] === dependency,
    `${packageName} root lock dependency is not pinned`,
  );
  const lockEntry = packageLock.packages[`node_modules/${packageName}`];
  assert(lockEntry?.version === sdk.version, `${packageName} lock version differs`);
  assert(
    lockEntry?.resolved === sdk.artifact.replace(/^vendor\//, "file:vendor/"),
    `${packageName} lock path is not pinned`,
  );
  assert(lockEntry?.integrity === sdk.integrity, `${packageName} lock integrity differs`);
}
assert(sdk.publicRef === "refs/heads/integration/public-alias-sdk", "SDK public ref differs");
assert(sdk.workflow?.conclusion === "success", "SDK workflow did not conclude successfully");
assert(Number.isSafeInteger(sdk.workflow?.runId), "SDK workflow run ID is invalid");
assert(Number.isSafeInteger(sdk.workflow?.artifactId), "SDK workflow artifact ID is invalid");
assert(
  sdk.workflow?.artifactName === `alias-sdk-release-candidate-${sdk.sourceCommit}`,
  "SDK workflow artifact name differs",
);
assert(
  /^[0-9a-f]{64}$/.test(sdk.workflow?.artifactZipSha256),
  "SDK workflow artifact ZIP SHA-256 is invalid",
);

const metadata = fs.readFileSync(path.join(repositoryRoot, sdk.metadata), "utf8");
for (const value of [
  sdk.version,
  sdk.sourceCommit,
  sdk.sha256,
  sdk.integrity,
  sdk.provenance,
  sdk.provenanceSha256,
  sdk.candidateChecksums,
  sdk.candidateChecksumsSha256,
  String(sdk.workflow.runId),
  String(sdk.workflow.artifactId),
  sdk.workflow.artifactName,
  sdk.workflow.artifactZipSha256,
]) {
  assert(metadata.includes(value), `SDK metadata does not contain ${value}`);
}

console.log(`Verified ${sdk.package}@${sdk.version} from ${sdk.sourceCommit} (${sdk.sha256})`);
