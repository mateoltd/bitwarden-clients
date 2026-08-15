import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, parseArgs, readJson, repositoryRoot, run } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.install !== true) {
  throw new Error("Commercial SDK installation requires the explicit --install flag");
}

const overlay = readJson(path.join(repositoryRoot, "release/commercial-sdk-overlay.json"));
if (
  overlay.schemaVersion !== 1 ||
  overlay.graph !== "commercial-overlay" ||
  overlay.package?.name !== "@bitwarden/commercial-sdk-internal" ||
  typeof overlay.package.version !== "string" ||
  typeof overlay.package.registryTarball !== "string" ||
  !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(overlay.package.integrity ?? "")
) {
  throw new Error("Commercial SDK overlay is invalid");
}

const response = await fetch(overlay.package.registryTarball);
assert(response.ok, `Commercial SDK download failed with HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
assert(integrity === overlay.package.integrity, "Commercial SDK archive integrity differs");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bitwarden-commercial-sdk-"));
const archivePath = path.join(temporaryDirectory, "commercial-sdk.tgz");
try {
  fs.writeFileSync(archivePath, archive);
  run("npm", [
    "install",
    "--no-save",
    "--package-lock=false",
    "--ignore-scripts",
    "--legacy-peer-deps",
    archivePath,
  ]);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

const installed = readJson(
  path.join(repositoryRoot, "node_modules/@bitwarden/commercial-sdk-internal/package.json"),
);
assert(
  installed.name === overlay.package.name &&
    installed.version === overlay.package.version &&
    installed.license === overlay.package.license,
  "Installed commercial SDK identity differs from the explicit overlay",
);
