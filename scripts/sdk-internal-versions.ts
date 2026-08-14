/* eslint-disable no-console */

/// Ensure that `sdk-internal` and `commercial-sdk-internal` dependencies have matching versions.

import { createHash } from "crypto";
import fs from "fs";
import path from "path";

const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
);

const sdkInternal = packageJson.dependencies["@bitwarden/sdk-internal"];
const aliasSdkInternal = packageJson.dependencies["@bitwarden/alias-sdk-internal"];
const commercialSdkInternal = packageJson.dependencies["@bitwarden/commercial-sdk-internal"];

const canonicalAliasArtifact = "file:vendor/bitwarden-sdk-internal-0.2.0-alias-platform.2.tgz";
const canonicalAliasArtifactSha256 =
  "bc9106926f418fbc139e4bb29031e2d27cf59e503abcd08455cc29ea8f79af47";
const sdkVersion = sdkInternal === canonicalAliasArtifact ? "0.2.0-main.950" : sdkInternal;

if (aliasSdkInternal !== canonicalAliasArtifact) {
  console.error(
    `Alias SDK must use the canonical verified artifact (${canonicalAliasArtifact}), found ${aliasSdkInternal}.`,
  );
  process.exit(1);
}

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
