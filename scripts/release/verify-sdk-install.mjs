import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { assert, hashFile, readManifest, repositoryRoot } from "./lib.mjs";

const manifest = readManifest();
const sdk = manifest.canonicalSdk;
const artifact = path.join(repositoryRoot, sdk.artifact);

assert(hashFile(artifact) === sdk.sha256, "Vendored SDK artifact SHA-256 differs from the pin");

for (const packageName of ["sdk-internal", "alias-sdk-internal"]) {
  const installedDirectory = path.join(repositoryRoot, "node_modules/@bitwarden", packageName);
  const stat = fs.lstatSync(installedDirectory);
  assert(!stat.isSymbolicLink(), `${packageName} must be a physical npm install, not a symlink`);

  const realDirectory = fs.realpathSync(installedDirectory);
  const expectedRoot = `${path.join(repositoryRoot, "node_modules/@bitwarden")}${path.sep}`;
  assert(realDirectory.startsWith(expectedRoot), `${packageName} resolves outside node_modules`);
  assert(
    !realDirectory.includes("provider-neutral-sdk-runtime"),
    `${packageName} resolves through the obsolete temporary SDK runtime`,
  );

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(installedDirectory, "package.json"), "utf8"),
  );
  assert(packageJson.name === sdk.package, `${packageName} package identity differs from the pin`);
  assert(packageJson.version === sdk.version, `${packageName} version differs from the pin`);
}

const consumers = ["apps/browser", "apps/web", "apps/desktop", "apps/cli", "libs/common"];
for (const consumer of consumers) {
  const require = createRequire(path.join(repositoryRoot, consumer, "package.json"));
  const canonical = require("@bitwarden/sdk-internal");
  const alias = require("@bitwarden/alias-sdk-internal");
  assert(
    typeof canonical.PasswordManagerClient === "function",
    `${consumer} cannot load PasswordManagerClient from the canonical SDK`,
  );
  assert(
    typeof alias.create_alias_reference === "function",
    `${consumer} cannot load create_alias_reference from the alias SDK`,
  );
}

console.log(
  `Verified physical ${sdk.version} SDK installs in ${consumers.length} real consumer contexts (${sdk.sha256})`,
);
