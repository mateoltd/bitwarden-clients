/* eslint-disable no-console */

/// Ensure that `sdk-internal` and `commercial-sdk-internal` dependencies have matching versions.

import { createHash } from "crypto";
import fs from "fs";
import path from "path";

const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
);

const sdkInternal = packageJson.dependencies["@bitwarden/sdk-internal"];
const commercialSdkInternal = packageJson.dependencies["@bitwarden/commercial-sdk-internal"];

const canonicalAliasArtifact = "file:vendor/bitwarden-sdk-internal-0.2.0-main.950.tgz";
const canonicalAliasArtifactSha256 =
  "fdf32cce3c7bbb16e6c439a068270b6839e6ac590098f2a0ca89b383899ce012";
const sdkVersion = sdkInternal === canonicalAliasArtifact ? "0.2.0-main.950" : sdkInternal;

if (sdkVersion !== commercialSdkInternal) {
  console.error(
    `Version mismatch between @bitwarden/sdk-internal (${sdkInternal}) and @bitwarden/commercial-sdk-internal (${commercialSdkInternal}), must be an exact match.`,
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
