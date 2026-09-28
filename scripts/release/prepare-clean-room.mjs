import fs from "node:fs";
import path from "node:path";

import { assert, readJson, repositoryRoot } from "./lib.mjs";

assert(
  !fs.existsSync(path.join(repositoryRoot, "bitwarden_license")),
  "Commercial source is present",
);
const packageFile = path.join(repositoryRoot, "package.json");
const lockFile = path.join(repositoryRoot, "package-lock.json");
const packageJson = readJson(packageFile);
const packageLock = readJson(lockFile);

assert(
  !packageJson.dependencies?.["@bitwarden/commercial-sdk-internal"] &&
    !packageJson.devDependencies?.["@bitwarden/commercial-sdk-internal"],
  "Default package manifest is not OSS-only",
);
assert(
  !Object.keys(packageLock.packages ?? {}).some((key) =>
    key.startsWith("node_modules/@bitwarden/commercial-sdk-internal"),
  ),
  "Default lockfile is not OSS-only",
);
console.log("Verified checked-in OSS dependency graph without rewriting it");
