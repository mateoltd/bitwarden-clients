import fs from "node:fs";
import path from "node:path";

import { assert, readJson, repositoryRoot, writeJson } from "./lib.mjs";

assert(
  !fs.existsSync(path.join(repositoryRoot, "bitwarden_license")),
  "Commercial source is present",
);
const packageFile = path.join(repositoryRoot, "package.json");
const lockFile = path.join(repositoryRoot, "package-lock.json");
const packageJson = readJson(packageFile);
const packageLock = readJson(lockFile);

delete packageJson.dependencies?.["@bitwarden/commercial-sdk-internal"];
delete packageJson.devDependencies?.["@bitwarden/commercial-sdk-internal"];
delete packageLock.packages?.[""]?.dependencies?.["@bitwarden/commercial-sdk-internal"];
delete packageLock.packages?.[""]?.devDependencies?.["@bitwarden/commercial-sdk-internal"];
for (const key of Object.keys(packageLock.packages ?? {})) {
  if (
    key === "node_modules/@bitwarden/commercial-sdk-internal" ||
    key.startsWith("node_modules/@bitwarden/commercial-sdk-internal/") ||
    key.startsWith("bitwarden_license/")
  ) {
    delete packageLock.packages[key];
  }
}

writeJson(packageFile, packageJson);
writeJson(lockFile, packageLock);
console.log("Prepared lock-preserving OSS dependency graph");
