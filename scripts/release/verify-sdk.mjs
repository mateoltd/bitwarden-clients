import fs from "node:fs";
import path from "node:path";

import {
  assert,
  hashFile,
  parseSdkProducerToolchainEvidence,
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
const sbomFile = path.join(repositoryRoot, sdk.sbom);
const sigstoreBundleFile = path.join(repositoryRoot, sdk.sigstoreBundle);
const buildEnvironmentFile = path.join(repositoryRoot, sdk.buildEnvironment);
const toolchainHandoffFile = path.join(repositoryRoot, sdk.toolchainHandoff);
const packageJson = readJson(path.join(repositoryRoot, "package.json"));
const packageLock = readJson(path.join(repositoryRoot, "package-lock.json"));

assert(fs.existsSync(artifact), `Pinned SDK artifact is missing: ${sdk.artifact}`);
assert(fs.existsSync(provenanceFile), `Pinned SDK provenance is missing: ${sdk.provenance}`);
assert(
  fs.existsSync(candidateChecksumsFile),
  `Pinned SDK checksum index is missing: ${sdk.candidateChecksums}`,
);
assert(fs.existsSync(sbomFile), `Pinned SDK SBOM is missing: ${sdk.sbom}`);
assert(
  fs.existsSync(sigstoreBundleFile),
  `Pinned SDK Sigstore bundle is missing: ${sdk.sigstoreBundle}`,
);
assert(
  fs.existsSync(buildEnvironmentFile),
  `Pinned SDK build environment is missing: ${sdk.buildEnvironment}`,
);
assert(
  fs.existsSync(toolchainHandoffFile),
  `Pinned SDK toolchain handoff is missing: ${sdk.toolchainHandoff}`,
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
assert(hashFile(sbomFile) === sdk.sbomSha256, "Pinned SDK SBOM SHA-256 does not match");
assert(
  hashFile(sigstoreBundleFile) === sdk.sigstoreBundleSha256,
  "Pinned SDK Sigstore bundle SHA-256 does not match",
);
assert(
  hashFile(buildEnvironmentFile) === sdk.buildEnvironmentSha256,
  "Pinned SDK raw build environment SHA-256 does not match the manifest",
);
assert(
  hashFile(toolchainHandoffFile) === sdk.toolchainHandoffSha256,
  "Pinned SDK toolchain handoff SHA-256 does not match the manifest",
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
  embeddedPackage.license === "GPL-3.0-only",
  `Pinned public SDK is not GPL-3.0-only: ${embeddedPackage.license ?? "missing license"}`,
);
assert(
  embeddedPackage.repository?.url === "git+https://github.com/bitwarden/sdk-internal.git",
  "Pinned public SDK package metadata names an unexpected source repository",
);
assert(
  embeddedCommit === sdk.sourceCommit,
  "Embedded SDK source commit does not match the manifest",
);

const provenance = readJson(provenanceFile);
assert(
  provenance.schemaVersion === 3 && sdk.handoffSchemaVersion === 3,
  "Unsupported SDK handoff manifest schema",
);
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
assert(checksums.size === provenance.artifacts.length + 1, "SDK artifact inventories differ");
for (const entry of provenance.artifacts) {
  assert(checksums.get(entry.path) === entry.sha256, `SDK checksum differs: ${entry.path}`);
}
const sbomEvidence = provenance.evidence?.sbom;
assert(
  sbomEvidence?.path === "SBOM.cdx.json" &&
    sbomEvidence?.sha256 === sdk.sbomSha256 &&
    sbomEvidence?.bytes === fs.statSync(sbomFile).size &&
    checksums.get(sbomEvidence.path) === sdk.sbomSha256,
  "SDK SBOM evidence differs",
);
const sbom = readJson(sbomFile);
assert(
  sbom.bomFormat === "CycloneDX" &&
    sbom.specVersion === "1.6" &&
    Array.isArray(sbom.components) &&
    Array.isArray(sbom.dependencies) &&
    sbom.metadata?.properties?.some(
      (property) => property.name === "bitwarden:license-boundary" && property.value === "GPL-only",
    ),
  "SDK SBOM contract differs",
);
const checksumLine = `${sdk.sha256}  ${packageRecord.artifact.path}`;
assert(
  checksumLines.includes(checksumLine),
  "SDK candidate checksum index does not contain the pinned package",
);
const rawBuildEnvironment = fs.readFileSync(buildEnvironmentFile, "utf8");
const parsedProducerEvidence = parseSdkProducerToolchainEvidence(rawBuildEnvironment);
const { sourceCommit: producerSourceCommit, ...parsedProducerToolchain } = parsedProducerEvidence;
assert(producerSourceCommit === sdk.sourceCommit, "SDK build environment source commit differs");
assert(
  JSON.stringify(parsedProducerToolchain) === JSON.stringify(sdk.producerToolchain),
  "SDK producer toolchain does not match the named manifest fields",
);
const toolchainHandoff = readJson(toolchainHandoffFile);
assert(
  toolchainHandoff.schemaVersion === 1 &&
    toolchainHandoff.evidenceType === "client-sdk-toolchain-handoff",
  "SDK toolchain handoff has an unsupported schema",
);
assert(
  toolchainHandoff.sdkProducer?.evidence?.path === sdk.buildEnvironment &&
    toolchainHandoff.sdkProducer?.evidence?.sha256 === sdk.buildEnvironmentSha256,
  "SDK toolchain handoff does not identify the raw producer evidence",
);
assert(
  JSON.stringify(toolchainHandoff.sdkProducer?.toolchain) === JSON.stringify(sdk.producerToolchain),
  "SDK toolchain handoff differs from the manifest producer toolchain",
);
assert(
  toolchainHandoff.clientConsumer?.manifestPath ===
    "release/alias-client-release.json#/clientToolchain" &&
    JSON.stringify(toolchainHandoff.clientConsumer?.toolchain) ===
      JSON.stringify(manifest.clientToolchain),
  "SDK toolchain handoff differs from the manifest client consumer toolchain",
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
assert(
  sdk.publicRef === "refs/heads/integration/provider-neutral-alias-upstream-sync",
  "SDK public ref differs",
);
const expectedRepository = sdk.sourceRepository.replace(/\.git$/, "");
const expectedWorkflowRef = `${expectedRepository.replace(/^https:\/\/github\.com\//, "")}/.github/workflows/alias-sdk-release.yml@${sdk.publicRef}`;
const expectedBuilderId = `${expectedRepository}/actions/runs/${sdk.workflow.runId}/attempts/1`;
assert(
  provenance.provenance?.sourceRepository === expectedRepository &&
    provenance.provenance?.workflowRef === expectedWorkflowRef &&
    provenance.provenance?.builderId === expectedBuilderId &&
    provenance.provenance?.eventName === "push" &&
    provenance.provenance?.keylessAttestation?.issuer ===
      "https://token.actions.githubusercontent.com",
  "SDK handoff attestation coordinates differ",
);
assert(
  JSON.stringify(sdk.attestation) ===
    JSON.stringify({
      issuer: provenance.provenance.keylessAttestation.issuer,
      sourceRepository: expectedRepository,
      sourceRef: sdk.publicRef,
      sourceCommit: sdk.sourceCommit,
      workflowRef: expectedWorkflowRef,
      builderId: expectedBuilderId,
      runnerEnvironment: "github-hosted",
    }),
  "SDK release attestation coordinates differ",
);
const bundle = readJson(sigstoreBundleFile);
assert(
  bundle.mediaType === "application/vnd.dev.sigstore.bundle.v0.3+json" &&
    typeof bundle.verificationMaterial?.certificate?.rawBytes === "string" &&
    bundle.verificationMaterial.certificate.rawBytes.length > 0 &&
    Array.isArray(bundle.verificationMaterial?.tlogEntries) &&
    bundle.verificationMaterial.tlogEntries.length > 0 &&
    bundle.verificationMaterial.tlogEntries.every(
      (entry) =>
        entry.kindVersion?.kind === "dsse" &&
        entry.inclusionPromise?.signedEntryTimestamp &&
        entry.inclusionProof?.checkpoint?.envelope,
    ) &&
    bundle.dsseEnvelope?.payloadType === "application/vnd.in-toto+json" &&
    Array.isArray(bundle.dsseEnvelope?.signatures) &&
    bundle.dsseEnvelope.signatures.length > 0,
  "SDK Sigstore bundle contract differs",
);
let statement;
try {
  statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
} catch {
  throw new Error("SDK Sigstore statement is invalid");
}
const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
const github = statement.predicate?.buildDefinition?.internalParameters?.github;
const dependencies = statement.predicate?.buildDefinition?.resolvedDependencies;
assert(
  statement._type === "https://in-toto.io/Statement/v1" &&
    statement.predicateType === "https://slsa.dev/provenance/v1" &&
    statement.predicate?.buildDefinition?.buildType ===
      "https://actions.github.io/buildtypes/workflow/v1" &&
    workflow?.repository === expectedRepository &&
    workflow?.ref === sdk.publicRef &&
    workflow?.path === ".github/workflows/alias-sdk-release.yml" &&
    github?.event_name === "push" &&
    github?.runner_environment === "github-hosted" &&
    dependencies?.length === 1 &&
    dependencies[0]?.uri === `git+${expectedRepository}@${sdk.publicRef}` &&
    dependencies[0]?.digest?.gitCommit === sdk.sourceCommit &&
    statement.predicate?.runDetails?.builder?.id ===
      `${expectedRepository}/.github/workflows/alias-sdk-release.yml@${sdk.publicRef}` &&
    statement.predicate?.runDetails?.metadata?.invocationId === expectedBuilderId,
  "SDK Sigstore statement coordinates differ",
);
const attestedSubjects = new Set(
  statement.subject?.map((subject) => `${subject.name}\0${subject.digest?.sha256}`) ?? [],
);
for (const [relative, digest] of checksums) {
  assert(
    attestedSubjects.has(`${path.posix.basename(relative)}\0${digest}`),
    `SDK candidate input is not attested: ${relative}`,
  );
}
assert(
  attestedSubjects.has(`handoff-manifest.json\0${sdk.provenanceSha256}`),
  "SDK handoff manifest is not attested",
);
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
  sdk.sbom,
  sdk.sbomSha256,
  sdk.sigstoreBundle,
  sdk.sigstoreBundleSha256,
  sdk.attestation.workflowRef,
  sdk.attestation.builderId,
  sdk.attestation.runnerEnvironment,
  sdk.buildEnvironment,
  sdk.buildEnvironmentSha256,
  sdk.toolchainHandoff,
  sdk.toolchainHandoffSha256,
  sdk.producerToolchain.node,
  sdk.producerToolchain.npm,
  sdk.producerToolchain.rust,
  sdk.producerToolchain.wasmOpt,
  String(sdk.workflow.runId),
  String(sdk.workflow.artifactId),
  sdk.workflow.artifactName,
  sdk.workflow.artifactZipSha256,
]) {
  assert(metadata.includes(value), `SDK metadata does not contain ${value}`);
}

console.log(`Verified ${sdk.package}@${sdk.version} from ${sdk.sourceCommit} (${sdk.sha256})`);
