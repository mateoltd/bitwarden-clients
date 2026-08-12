/* eslint-disable no-console */

/// Ensure that `sdk-internal` and `commercial-sdk-internal` dependencies have matching versions.

import { createHash } from "crypto";
import fs from "fs";
import path from "path";

const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
);
const releaseManifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "release", "alias-client-release.json"), "utf8"),
);

const sdkInternal = packageJson.dependencies["@bitwarden/sdk-internal"];
const commercialSdkInternal = packageJson.dependencies["@bitwarden/commercial-sdk-internal"];

const canonicalAliasArtifact = `file:${releaseManifest.canonicalSdk.artifact}`;
const canonicalAliasArtifactSha256 = releaseManifest.canonicalSdk.sha256;
const sdkVersion =
  sdkInternal === canonicalAliasArtifact ? releaseManifest.canonicalSdk.version : sdkInternal;

if (sdkInternal !== canonicalAliasArtifact && sdkVersion !== commercialSdkInternal) {
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

console.log(
  sdkInternal === canonicalAliasArtifact
    ? `Canonical OSS SDK artifact is checksum-pinned: ${sdkVersion}`
    : `All dependencies have matching versions: ${sdkVersion}`,
);
