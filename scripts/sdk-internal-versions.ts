/* eslint-disable no-console */

/// Ensure that public SDK pins and the explicit commercial overlay remain compatible.

import { createHash } from "crypto";
import fs from "fs";
import path from "path";

const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
);
const commercialOverlay = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "release", "commercial-sdk-overlay.json"),
    "utf8",
  ),
);

const sdkInternal = packageJson.dependencies["@bitwarden/sdk-internal"];
const aliasSdkInternal = packageJson.dependencies["@bitwarden/alias-sdk-internal"];
const commercialSdkInternal = commercialOverlay.package?.version;

const canonicalAliasArtifact =
  "file:vendor/bitwarden-sdk-internal-0.3.0-alias-provider-neutral.1.tgz";
const canonicalAliasArtifactSha256 =
  "1f40d1c145056b014184b678b57c61ac8c173efc2499f178066737ebb1647394";
const sdkVersion = sdkInternal === canonicalAliasArtifact ? "0.2.0-main.971" : sdkInternal;

if (
  packageJson.dependencies["@bitwarden/commercial-sdk-internal"] !== undefined ||
  packageJson.devDependencies?.["@bitwarden/commercial-sdk-internal"] !== undefined
) {
  console.error("The default dependency graph must not include the commercial SDK overlay.");
  process.exit(1);
}

if (
  commercialOverlay.schemaVersion !== 1 ||
  commercialOverlay.graph !== "commercial-overlay" ||
  commercialOverlay.package?.name !== "@bitwarden/commercial-sdk-internal"
) {
  console.error("The commercial SDK overlay is invalid.");
  process.exit(1);
}

if (aliasSdkInternal !== canonicalAliasArtifact) {
  console.error(
    `Alias SDK must use the canonical verified artifact (${canonicalAliasArtifact}), found ${aliasSdkInternal}.`,
  );
  process.exit(1);
}

if (sdkVersion !== commercialSdkInternal) {
  console.error(
    `Version mismatch between @bitwarden/sdk-internal (${sdkInternal}) and the explicit commercial overlay (${commercialSdkInternal}), must be an exact match.`,
  );
  process.exit(1);
}

if (sdkInternal === canonicalAliasArtifact) {
  const artifactPath = path.join(__dirname, "..", "..", canonicalAliasArtifact.slice(5));
  const digest = createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex");
  if (digest !== canonicalAliasArtifactSha256) {
    console.error(`Canonical alias SDK artifact checksum mismatch: ${digest}`);
    process.exit(1);
  }
}

console.log(`All dependencies have matching versions: ${sdkVersion}`);
