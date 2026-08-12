import path from "node:path";

import { assert, readJson, readManifest, repositoryRoot } from "./lib.mjs";

const manifest = readManifest();
const rootPackage = readJson(path.join(repositoryRoot, "package.json"));
const cliPackage = readJson(path.join(repositoryRoot, "apps/cli/package.json"));
const publicPackageScripts = [
  "package:oss:win",
  "package:oss:mac",
  "package:oss:mac-arm64",
  "package:oss:lin",
  "package:oss:lin-arm64",
];

assert(
  rootPackage.devDependencies["@yao-pkg/pkg"] === manifest.toolchains.pkg,
  "CLI packager version does not match the release manifest",
);
for (const name of publicPackageScripts) {
  const command = cliPackage.scripts[name];
  assert(typeof command === "string", `Missing public CLI packaging command: ${name}`);
  assert(command.includes("--no-bytecode"), `${name} enables nondeterministic V8 bytecode`);
  assert(
    command.includes('--public-packages "*"') && command.includes("--public"),
    `${name} does not explicitly expose public GPL package sources`,
  );
}

console.log(`Verified deterministic CLI packaging policy for ${publicPackageScripts.length} targets`);
