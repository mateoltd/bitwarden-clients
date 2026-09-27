import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";

import { satisfies } from "semver";
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
  !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(overlay.package.integrity ?? "") ||
  !/^[0-9a-f]{64}$/.test(overlay.package.sha256 ?? "")
) {
  throw new Error("Commercial SDK overlay is invalid");
}

const response = await fetch(overlay.package.registryTarball);
assert(response.ok, `Commercial SDK download failed with HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
const sha256 = createHash("sha256").update(archive).digest("hex");
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
assert(sha256 === overlay.package.sha256, "Commercial SDK archive SHA-256 differs");
assert(integrity === overlay.package.integrity, "Commercial SDK archive integrity differs");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bitwarden-commercial-sdk-"));
const archivePath = path.join(temporaryDirectory, "commercial-sdk.tgz");
try {
  fs.writeFileSync(archivePath, archive);
  // Overlay one verified package without re-resolving or pruning the frozen public graph.
  run("tar", ["-xzf", archivePath, "-C", temporaryDirectory]);
  const unpacked = path.join(temporaryDirectory, "package");
  const candidate = readJson(path.join(unpacked, "package.json"));
  assert(
    candidate.name === overlay.package.name &&
      candidate.version === overlay.package.version &&
      candidate.license === overlay.package.license,
    "Commercial SDK archive identity differs from the explicit overlay",
  );
  const lock = readJson(path.join(repositoryRoot, "package-lock.json"));
  function copyFrozenDependencies(manifest, source, target, ancestry = []) {
    const require = createRequire(path.join(source, "package.json"));
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      const dependencyPath = require.resolve
        .paths(name)
        .map((directory) => path.join(directory, name, "package.json"))
        .find(
          (file) =>
            file.startsWith(path.join(repositoryRoot, "node_modules") + path.sep) &&
            fs.existsSync(file),
        );
      assert(dependencyPath, `Frozen dependency ${name} is missing`);
      const directory = path.dirname(dependencyPath);
      const dependency = readJson(dependencyPath);
      const locked = lock.packages[path.relative(repositoryRoot, directory)];
      assert(
        locked?.integrity &&
          locked.version === dependency.version &&
          satisfies(dependency.version, range),
        `Frozen dependency ${name} does not satisfy the SDK overlay or lockfile`,
      );
      assert(!ancestry.includes(directory), `Cyclic overlay dependency ${name}`);
      const destination = path.join(target, "node_modules", name);
      fs.cpSync(directory, destination, {
        recursive: true,
        filter: (file) => file === directory || path.basename(file) !== "node_modules",
      });
      copyFrozenDependencies(dependency, directory, destination, [...ancestry, directory]);
    }
  }
  copyFrozenDependencies(
    candidate,
    path.join(repositoryRoot, "node_modules/@bitwarden/sdk-internal"),
    unpacked,
  );
  const destination = path.join(repositoryRoot, "node_modules/@bitwarden/commercial-sdk-internal");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(unpacked, destination, { recursive: true });
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
