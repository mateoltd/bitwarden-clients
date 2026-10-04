import fs from "node:fs";
import path from "node:path";

import {
  assert,
  hashFile,
  parseArgs,
  parseSdkProducerToolchainEvidence,
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
const sourceRef = requireString(args["source-ref"], "--source-ref is required");
assert(/^[0-9a-f]{40}$/.test(sourceCommit), "--source-commit must be a full lowercase Git commit");
assert(
  /^refs\/heads\/[a-z0-9][a-z0-9._/-]*$/.test(sourceRef),
  "--source-ref must be a full branch ref",
);
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
  return resolveCandidate(
    relative.startsWith("artifacts/") ? relative : path.posix.join("artifacts", relative),
  );
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

function parseAttestation(bundleFile, provenanceFile, sums, provenance) {
  const bundle = readJson(bundleFile);
  assert(
    bundle.mediaType === "application/vnd.dev.sigstore.bundle.v0.3+json",
    "Unsupported SDK Sigstore bundle",
  );
  assert(
    typeof bundle.verificationMaterial?.certificate?.rawBytes === "string" &&
      bundle.verificationMaterial.certificate.rawBytes.length > 0,
    "SDK Sigstore signing certificate is missing",
  );
  const transparencyEntries = bundle.verificationMaterial?.tlogEntries;
  assert(
    Array.isArray(transparencyEntries) &&
      transparencyEntries.length > 0 &&
      transparencyEntries.every(
        (entry) =>
          entry.kindVersion?.kind === "dsse" &&
          entry.inclusionPromise?.signedEntryTimestamp &&
          entry.inclusionProof?.checkpoint?.envelope,
      ),
    "SDK Sigstore transparency evidence is incomplete",
  );
  const envelope = bundle.dsseEnvelope;
  assert(envelope?.payloadType === "application/vnd.in-toto+json", "Invalid SDK DSSE payload");
  assert(
    Array.isArray(envelope.signatures) &&
      envelope.signatures.length > 0 &&
      envelope.signatures.every((signature) => typeof signature.sig === "string"),
    "SDK DSSE signature is missing",
  );

  let statement;
  try {
    statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  } catch {
    throw new Error("SDK DSSE statement is invalid");
  }
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  const github = statement.predicate?.buildDefinition?.internalParameters?.github;
  const dependency = statement.predicate?.buildDefinition?.resolvedDependencies;
  const runDetails = statement.predicate?.runDetails;
  const expectedRepository = provenance.provenance?.sourceRepository;
  const expectedWorkflowRef = `${expectedRepository}/.github/workflows/alias-sdk-release.yml@${sourceRef}`;
  assert(statement._type === "https://in-toto.io/Statement/v1", "Invalid SDK statement type");
  assert(
    statement.predicateType === "https://slsa.dev/provenance/v1",
    "Invalid SDK predicate type",
  );
  assert(
    statement.predicate?.buildDefinition?.buildType ===
      "https://actions.github.io/buildtypes/workflow/v1",
    "Invalid SDK build type",
  );
  assert(
    workflow?.repository === expectedRepository &&
      workflow?.ref === sourceRef &&
      workflow?.path === ".github/workflows/alias-sdk-release.yml",
    "SDK attestation workflow differs",
  );
  assert(
    github?.event_name === "push" && github?.runner_environment === "github-hosted",
    "SDK attestation runner or trigger differs",
  );
  assert(
    Array.isArray(dependency) &&
      dependency.length === 1 &&
      dependency[0]?.uri === `git+${expectedRepository}@${sourceRef}` &&
      dependency[0]?.digest?.gitCommit === sourceCommit,
    "SDK attestation source ref or commit differs",
  );
  assert(
    runDetails?.builder?.id === expectedWorkflowRef &&
      runDetails?.metadata?.invocationId ===
        `${expectedRepository}/actions/runs/${workflowRunId}/attempts/1`,
    "SDK attestation builder or invocation differs",
  );
  assert(
    provenance.provenance?.workflowRef ===
      `${expectedRepository.replace(/^https:\/\/github\.com\//, "")}/.github/workflows/alias-sdk-release.yml@${sourceRef}` &&
      provenance.provenance?.builderId === runDetails.metadata.invocationId &&
      provenance.provenance?.eventName === "push" &&
      provenance.provenance?.keylessAttestation?.issuer ===
        "https://token.actions.githubusercontent.com",
    "SDK handoff attestation coordinates differ",
  );

  const subjects = new Set(
    statement.subject?.map((subject) => `${subject.name}\0${subject.digest?.sha256}`) ?? [],
  );
  for (const [relative, digest] of sums) {
    assert(
      subjects.has(`${path.posix.basename(relative)}\0${digest}`),
      `SDK candidate file is not attested: ${relative}`,
    );
  }
  const provenanceSha256 = hashFile(provenanceFile);
  assert(
    subjects.has(`${path.basename(provenanceFile)}\0${provenanceSha256}`),
    "SDK handoff manifest is not attested",
  );

  return {
    issuer: provenance.provenance.keylessAttestation.issuer,
    sourceRepository: expectedRepository,
    sourceRef,
    sourceCommit,
    workflowRef: provenance.provenance.workflowRef,
    builderId: provenance.provenance.builderId,
    runnerEnvironment: github.runner_environment,
  };
}

assert(
  fs.statSync(candidateDirectory, { throwIfNoEntry: false })?.isDirectory(),
  "SDK candidate directory is missing",
);
const provenanceFile = resolveCandidate("handoff-manifest.json");
const sumsFile = resolveCandidate("SHA256SUMS");
const sbomFile = resolveCandidate("SBOM.cdx.json");
const sigstoreBundleFile = resolveCandidate("PROVENANCE.sigstore.json");
assert(
  fs.statSync(provenanceFile, { throwIfNoEntry: false })?.isFile(),
  "SDK handoff manifest is missing",
);
assert(fs.statSync(sumsFile, { throwIfNoEntry: false })?.isFile(), "SDK SHA256SUMS is missing");
assert(fs.statSync(sbomFile, { throwIfNoEntry: false })?.isFile(), "SDK SBOM is missing");
assert(
  fs.statSync(sigstoreBundleFile, { throwIfNoEntry: false })?.isFile(),
  "SDK Sigstore bundle is missing",
);

const provenance = readJson(provenanceFile);
assert(provenance.schemaVersion === 3, "Unsupported SDK handoff manifest schema");
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
assert(
  sums.size === provenance.artifacts.length + 1,
  "SDK checksum and artifact inventories differ",
);
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
const sbomEvidence = provenance.evidence?.sbom;
assert(sbomEvidence?.path === "SBOM.cdx.json", "SDK SBOM path differs");
assert(fs.statSync(sbomFile).size === sbomEvidence.bytes, "SDK SBOM size differs");
assert(hashFile(sbomFile) === sbomEvidence.sha256, "SDK SBOM digest differs");
assert(sums.get(sbomEvidence.path) === sbomEvidence.sha256, "SDK SBOM index entry differs");
const attestation = parseAttestation(sigstoreBundleFile, provenanceFile, sums, provenance);

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
const rawBuildEnvironment = fs.readFileSync(buildEnvironmentFile, "utf8");
const parsedProducerEvidence = parseSdkProducerToolchainEvidence(rawBuildEnvironment);
assert(
  parsedProducerEvidence.sourceCommit === sourceCommit,
  "Published SDK build environment lacks the exact source commit",
);
const producerToolchain = {
  runnerImage: parsedProducerEvidence.runnerImage,
  node: parsedProducerEvidence.node,
  npm: parsedProducerEvidence.npm,
  rust: parsedProducerEvidence.rust,
  wasmOpt: parsedProducerEvidence.wasmOpt,
};

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
const sbomSha256 = hashFile(sbomFile);
const sigstoreBundleSha256 = hashFile(sigstoreBundleFile);
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
  assert(sbomSha256 === sdk.sbomSha256, "Checked SDK SBOM differs from the release manifest");
  assert(
    sigstoreBundleSha256 === sdk.sigstoreBundleSha256,
    "Checked SDK Sigstore bundle differs from the release manifest",
  );
  assert(
    JSON.stringify(attestation) === JSON.stringify(sdk.attestation),
    "Checked SDK attestation coordinates differ from the release manifest",
  );
  assert(
    hashFile(buildEnvironmentFile) === sdk.buildEnvironmentSha256,
    "Checked SDK producer environment differs from the release manifest",
  );
  assert(
    JSON.stringify(producerToolchain) === JSON.stringify(sdk.producerToolchain),
    "Checked SDK producer toolchain differs from the release manifest",
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
const relativeSbom = `vendor/${fileName.replace(/\.tgz$/, ".sbom.cdx.json")}`;
const relativeSigstoreBundle = `vendor/${fileName.replace(/\.tgz$/, ".provenance.sigstore.json")}`;
const relativeBuildEnvironment = `vendor/${fileName.replace(/\.tgz$/, ".build-environment.txt")}`;
const relativeToolchainHandoff = `vendor/${fileName.replace(/\.tgz$/, ".toolchain-handoff.json")}`;
fs.copyFileSync(artifact, path.join(repositoryRoot, relativeArtifact));
fs.copyFileSync(provenanceFile, path.join(repositoryRoot, relativeProvenance));
fs.copyFileSync(sumsFile, path.join(repositoryRoot, relativeChecksums));
fs.copyFileSync(sbomFile, path.join(repositoryRoot, relativeSbom));
fs.copyFileSync(sigstoreBundleFile, path.join(repositoryRoot, relativeSigstoreBundle));
fs.copyFileSync(buildEnvironmentFile, path.join(repositoryRoot, relativeBuildEnvironment));
const buildEnvironmentSha256 = hashFile(buildEnvironmentFile);
writeJson(path.join(repositoryRoot, relativeToolchainHandoff), {
  schemaVersion: 1,
  evidenceType: "client-sdk-toolchain-handoff",
  sdkProducer: {
    evidence: {
      path: relativeBuildEnvironment,
      sha256: buildEnvironmentSha256,
    },
    toolchain: producerToolchain,
  },
  clientConsumer: {
    manifestPath: "release/alias-client-release.json#/clientToolchain",
    toolchain: manifest.clientToolchain,
  },
});
const toolchainHandoffSha256 = hashFile(path.join(repositoryRoot, relativeToolchainHandoff));

Object.assign(manifest.canonicalSdk, {
  version,
  artifact: relativeArtifact,
  metadata: relativeMetadata,
  provenance: relativeProvenance,
  provenanceSha256,
  candidateChecksums: relativeChecksums,
  candidateChecksumsSha256,
  sbom: relativeSbom,
  sbomSha256,
  sigstoreBundle: relativeSigstoreBundle,
  sigstoreBundleSha256,
  handoffSchemaVersion: provenance.schemaVersion,
  attestation,
  buildEnvironment: relativeBuildEnvironment,
  buildEnvironmentSha256,
  toolchainHandoff: relativeToolchainHandoff,
  toolchainHandoffSha256,
  producerToolchain,
  sha256,
  integrity,
  sourceCommit,
  publicRef: sourceRef,
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
    `- Published CycloneDX SBOM: \`${relativeSbom}\``,
    `- SBOM SHA-256: \`${sbomSha256}\``,
    `- Published Sigstore bundle: \`${relativeSigstoreBundle}\``,
    `- Sigstore bundle SHA-256: \`${sigstoreBundleSha256}\``,
    `- Attested workflow: \`${attestation.workflowRef}\``,
    `- Attested builder: ${attestation.builderId}`,
    `- Attested runner: \`${attestation.runnerEnvironment}\``,
    `- Raw SDK producer environment: \`${relativeBuildEnvironment}\``,
    `- Raw SDK producer environment SHA-256: \`${buildEnvironmentSha256}\``,
    `- Client SDK toolchain handoff: \`${relativeToolchainHandoff}\``,
    `- Toolchain handoff SHA-256: \`${toolchainHandoffSha256}\``,
    "",
    "## SDK producer toolchain",
    "",
    `- Runner image: \`${producerToolchain.runnerImage}\``,
    `- Node: \`${producerToolchain.node}\``,
    `- npm: \`${producerToolchain.npm}\``,
    `- Rust: \`${producerToolchain.rust}\``,
    `- wasm-opt: \`${producerToolchain.wasmOpt}\``,
    "",
    "These values describe the separately produced SDK artifact and are validated independently",
    `from the alias client release toolchain, whose npm version is \`${manifest.clientToolchain.npm}\`.`,
    "",
    "This archive is an explicit, checksum-enforced build input for the public OSS clients.",
    "",
  ].join("\n"),
);

const npmVersion = run("npm", ["--version"], { capture: true });
assert(
  npmVersion === manifest.clientToolchain.npm,
  `npm ${manifest.clientToolchain.npm} is required; found ${npmVersion}`,
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
  oldSdk.sbom,
  oldSdk.sigstoreBundle,
  oldSdk.buildEnvironment,
  oldSdk.toolchainHandoff,
]) {
  if (
    typeof oldPath !== "string" ||
    [
      relativeArtifact,
      relativeMetadata,
      relativeProvenance,
      relativeChecksums,
      relativeSbom,
      relativeSigstoreBundle,
      relativeBuildEnvironment,
      relativeToolchainHandoff,
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
