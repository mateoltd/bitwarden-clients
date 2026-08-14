import fs from "node:fs";
import path from "node:path";

import {
  git,
  hashFile,
  parseArgs,
  readJson,
  readManifest,
  repositoryRoot,
  requireString,
  writeJson,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const artifactsDirectory = path.resolve(
  repositoryRoot,
  requireString(args.artifacts, "--artifacts is required"),
);
const sbomFile = path.resolve(repositoryRoot, requireString(args.sbom, "--sbom is required"));
const outputDirectory = path.resolve(
  repositoryRoot,
  requireString(args.output, "--output is required"),
);
const manifest = readManifest();
const sourceCommitFile = path.join(repositoryRoot, ".release-source-commit");
const sourceCommit = fs.existsSync(sourceCommitFile)
  ? fs.readFileSync(sourceCommitFile, "utf8").trim()
  : (process.env.GITHUB_SHA ?? git(["rev-parse", "HEAD"]));
const baseSbom = readJson(sbomFile);
fs.mkdirSync(outputDirectory, { recursive: true });

function isCommercial(component) {
  return (
    component.name === "commercial-sdk-internal" ||
    component["bom-ref"]?.includes("commercial-sdk-internal")
  );
}

const artifacts = fs
  .readdirSync(artifactsDirectory, { recursive: true })
  .map((entry) => path.join(artifactsDirectory, entry))
  .filter((file) => fs.statSync(file).isFile() && /\.(zip|tar\.gz)$/.test(file))
  .sort();

const sums = [];
for (const artifact of artifacts) {
  const name = path.basename(artifact);
  const digest = hashFile(artifact);
  const prefix = path.join(outputDirectory, name);
  const buildEnvironmentFile = `${artifact}.build.json`;
  const buildEnvironment = fs.existsSync(buildEnvironmentFile)
    ? readJson(buildEnvironmentFile)
    : {
        schemaVersion: 1,
        target: "source",
        sourceCommit,
        sourceDateEpoch: manifest.releaseLane.sourceDateEpoch,
        toolchains: manifest.toolchains,
        environment: {
          runnerOS: process.env.RUNNER_OS ?? process.platform,
          runnerArchitecture: process.env.RUNNER_ARCH ?? process.arch,
          runnerImage:
            [process.env.ImageOS, process.env.ImageVersion].filter(Boolean).join("-") || "local",
          node: process.version,
        },
      };
  sums.push(`${digest}  ${name}`);
  fs.writeFileSync(`${prefix}.sha256`, `${digest}  ${name}\n`);

  const sbom = structuredClone(baseSbom);
  sbom.serialNumber = `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  sbom.metadata ??= {};
  sbom.metadata.timestamp = new Date(manifest.releaseLane.sourceDateEpoch * 1000).toISOString();
  sbom.metadata.component = {
    type: "application",
    name,
    version: name.match(/-(\d{4}\.\d+\.\d+)\./)?.[1] ?? "candidate",
    hashes: [{ alg: "SHA-256", content: digest }],
    properties: [
      { name: "bitwarden:source-commit", value: sourceCommit },
      { name: "bitwarden:canonical-sdk-commit", value: manifest.canonicalSdk.sourceCommit },
      {
        name: "bitwarden:canonical-sdk-workflow-run",
        value: String(manifest.canonicalSdk.workflow.runId),
      },
    ],
  };
  sbom.components = (sbom.components ?? []).filter((component) => !isCommercial(component));
  const componentRefs = new Set(sbom.components.map((component) => component["bom-ref"]));
  sbom.dependencies = (sbom.dependencies ?? [])
    .filter((dependency) => !String(dependency.ref).includes("commercial-sdk-internal"))
    .map((dependency) => ({
      ...dependency,
      dependsOn: (dependency.dependsOn ?? []).filter(
        (reference) =>
          !String(reference).includes("commercial-sdk-internal") && componentRefs.has(reference),
      ),
    }));
  writeJson(`${prefix}.cdx.json`, sbom);

  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name, digest: { sha256: digest } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType:
          "https://github.com/mateoltd/bitwarden-clients/release/alias-client-candidate/v1",
        externalParameters: { target: name },
        internalParameters: {
          sourceDateEpoch: manifest.releaseLane.sourceDateEpoch,
          toolchains: manifest.toolchains,
          buildEnvironment,
        },
        resolvedDependencies: [
          { uri: manifest.releaseLane.sourceRepository, digest: { gitCommit: sourceCommit } },
          {
            uri: manifest.canonicalSdk.sourceRepository,
            digest: {
              gitCommit: manifest.canonicalSdk.sourceCommit,
              sha256: manifest.canonicalSdk.sha256,
            },
          },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/mateoltd/bitwarden-clients/actions" },
        metadata: { invocationId: process.env.GITHUB_RUN_ID ?? "local" },
      },
    },
  };
  fs.writeFileSync(`${prefix}.intoto.jsonl`, `${JSON.stringify(statement)}\n`);
  writeJson(`${prefix}.source.json`, {
    schemaVersion: 1,
    artifact: name,
    sha256: digest,
    source: {
      repository: manifest.releaseLane.sourceRepository,
      commit: sourceCommit,
      baseCommit: manifest.releaseLane.baseCommit,
    },
    canonicalSdk: {
      repository: manifest.canonicalSdk.sourceRepository,
      publicRef: manifest.canonicalSdk.publicRef,
      commit: manifest.canonicalSdk.sourceCommit,
      aliasReferenceSchemaVersion: manifest.canonicalSdk.aliasReferenceSchemaVersion,
      artifact: manifest.canonicalSdk.artifact,
      sha256: manifest.canonicalSdk.sha256,
      provenance: manifest.canonicalSdk.provenance,
      provenanceSha256: manifest.canonicalSdk.provenanceSha256,
      workflow: manifest.canonicalSdk.workflow,
    },
    unsigned: true,
  });
}

fs.writeFileSync(path.join(outputDirectory, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`Generated release metadata for ${artifacts.length} candidates`);
