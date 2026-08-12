import fs from "node:fs";
import path from "node:path";

import { parseArgs, repositoryRoot, writeJson } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const output = path.resolve(repositoryRoot, args.output ?? "license-inventory.json");
const inventory = {};
const visited = new Set();

function packageDirectories(nodeModules) {
  if (!fs.existsSync(nodeModules)) return [];
  return fs.readdirSync(nodeModules, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const entryPath = path.join(nodeModules, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      return fs
        .readdirSync(entryPath, { withFileTypes: true })
        .filter((child) => child.isDirectory() || child.isSymbolicLink())
        .map((child) => path.join(entryPath, child.name));
    }
    return entry.isDirectory() || entry.isSymbolicLink() ? [entryPath] : [];
  });
}

function scan(nodeModules) {
  for (const packageDirectory of packageDirectories(nodeModules)) {
    const realDirectory = fs.realpathSync(packageDirectory);
    if (visited.has(realDirectory)) continue;
    visited.add(realDirectory);
    const packageFile = path.join(realDirectory, "package.json");
    if (!fs.existsSync(packageFile)) continue;
    const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    if (packageJson.name && packageJson.version) {
      const declared = packageJson.license ?? packageJson.licenses;
      let licenses = Array.isArray(declared)
        ? declared.map((entry) => entry.type ?? entry).join(" OR ")
        : typeof declared === "object" && declared !== null
          ? (declared.type ?? "UNKNOWN")
          : (declared ?? "UNKNOWN");
      const relativePath = path.relative(repositoryRoot, realDirectory);
      if (
        !relativePath.startsWith(`node_modules${path.sep}`) &&
        /^(UNKNOWN|SEE LICENSE)/i.test(licenses)
      ) {
        licenses = "GPL-3.0";
      }
      inventory[`${packageJson.name}@${packageJson.version}`] = {
        licenses,
        repository:
          typeof packageJson.repository === "string"
            ? packageJson.repository
            : (packageJson.repository?.url ?? null),
        path: relativePath,
      };
    }
    scan(path.join(realDirectory, "node_modules"));
  }
}

scan(path.join(repositoryRoot, "node_modules"));
scan(path.join(repositoryRoot, "release/tooling/node_modules"));
writeJson(
  output,
  Object.fromEntries(
    Object.entries(inventory).sort(([left], [right]) => left.localeCompare(right)),
  ),
);
console.log(`Inventoried licenses for ${Object.keys(inventory).length} installed packages`);
