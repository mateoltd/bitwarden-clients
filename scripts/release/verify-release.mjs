import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { assert, git, readJson, readManifest, repositoryRoot, run } from "./lib.mjs";

run(process.execPath, ["scripts/release/verify-sdk.mjs"]);
run(process.execPath, ["scripts/release/scope-audit.mjs"]);

const manifest = readManifest();
const sourceCommitFile = path.join(repositoryRoot, ".release-source-commit");
let head;
let branch;
if (fs.existsSync(path.join(repositoryRoot, ".git"))) {
  head = git(["rev-parse", "HEAD"]);
  branch =
    git(["branch", "--show-current"]) || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  git(["merge-base", "--is-ancestor", manifest.releaseLane.baseCommit, head], { capture: false });
  const cleanCommits = git(["rev-list", "--reverse", `${manifest.releaseLane.baseCommit}..${head}`])
    .split("\n")
    .filter(Boolean);
  assert(cleanCommits.length > 0, "Clean release history has no commits after the pinned base");
  assert(
    git(["rev-parse", `${cleanCommits[0]}^`]) === manifest.releaseLane.baseCommit,
    "First clean release commit is not parented directly by the pinned base",
  );
  for (const source of [
    manifest.cleanHistoryInputs.clientV1Commit,
    manifest.cleanHistoryInputs.releaseCheckpointCommit,
    manifest.cleanHistoryInputs.arm64FixCommit,
  ]) {
    const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", source, head], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    assert(ancestry.status === 1, `Development ancestry entered the clean history: ${source}`);
  }
  assert(
    branch === manifest.releaseLane.branch,
    `Expected branch ${manifest.releaseLane.branch}, got ${branch}`,
  );
} else {
  assert(fs.existsSync(sourceCommitFile), "Exported source commit manifest is missing");
  head = fs.readFileSync(sourceCommitFile, "utf8").trim();
  branch = `${manifest.releaseLane.branch} (exported)`;
  assert(/^[0-9a-f]{40}$/.test(head), "Exported source commit is invalid");
}

assert(manifest.cleanHistoryInputs.stateOnly === true, "Clean history inputs must be state-only");

const targetIds = manifest.targets.map(({ id }) => id);
assert(new Set(targetIds).size === targetIds.length, "Release target IDs must be unique");
for (const target of manifest.targets) {
  assert(
    /^(browser|desktop|web|cli)$/.test(target.family),
    `Unknown target family: ${target.family}`,
  );
  assert(/^(zip|tar\.gz)$/.test(target.artifactFormat), `Unknown archive format: ${target.id}`);
}

for (const lock of [
  "package-lock.json",
  "apps/desktop/src/package-lock.json",
  "apps/desktop/native-messaging-test-runner/package-lock.json",
  "apps/desktop/desktop_native/Cargo.lock",
  "release/tooling/package-lock.json",
]) {
  assert(fs.existsSync(path.join(repositoryRoot, lock)), `Dependency lock is missing: ${lock}`);
}

const rootPackage = readJson(path.join(repositoryRoot, "package.json"));
const packageLock = readJson(path.join(repositoryRoot, "package-lock.json"));
assert(
  rootPackage.packageManager === `npm@${manifest.toolchains.npm}`,
  "packageManager does not match the release manifest",
);
assert(
  fs.readFileSync(path.join(repositoryRoot, ".nvmrc"), "utf8").trim() ===
    `v${manifest.toolchains.node}`,
  "Root Node pin does not match the release manifest",
);
assert(
  fs.readFileSync(path.join(repositoryRoot, "apps/cli/.nvmrc"), "utf8").trim() ===
    `v${manifest.toolchains.cliNode}`,
  "CLI Node pin does not match the release manifest",
);
assert(
  fs.readFileSync(path.join(repositoryRoot, ".python-version"), "utf8").trim() ===
    manifest.toolchains.python,
  "Python pin does not match the release manifest",
);
assert(
  readJson(path.join(repositoryRoot, "release/tooling/package.json")).packageManager ===
    `npm@${manifest.toolchains.npm}`,
  "Release tooling npm pin does not match the release manifest",
);
const rustToolchain = fs.readFileSync(
  path.join(repositoryRoot, "apps/desktop/desktop_native/rust-toolchain.toml"),
  "utf8",
);
assert(
  rustToolchain.includes(`channel = "${manifest.toolchains.rust}"`),
  "Rust pin does not match the release manifest",
);
const electronBuilder = readJson(path.join(repositoryRoot, "apps/desktop/electron-builder.json"));
assert(
  electronBuilder.electronVersion === manifest.toolchains.electron,
  "Electron pin does not match the release manifest",
);
assert(
  rootPackage.devDependencies["electron-builder"] === manifest.toolchains.electronBuilder,
  "electron-builder pin does not match the release manifest",
);
assert(
  rootPackage.devDependencies.playwright === manifest.toolchains.playwright,
  "Playwright pin does not match the release manifest",
);

if (process.env.OSS_CLEAN_ROOM === "1") {
  assert(
    !fs.existsSync(path.join(repositoryRoot, "bitwarden_license")),
    "Commercial source entered OSS clean room",
  );
  assert(
    !fs.existsSync(path.join(repositoryRoot, "node_modules/@bitwarden/commercial-sdk-internal")),
    "Commercial SDK package entered OSS clean room",
  );
  assert(
    !rootPackage.dependencies?.["@bitwarden/commercial-sdk-internal"] &&
      !rootPackage.devDependencies?.["@bitwarden/commercial-sdk-internal"],
    "Commercial SDK dependency entered OSS clean-room package manifest",
  );
  assert(
    !packageLock.packages?.[""]?.dependencies?.["@bitwarden/commercial-sdk-internal"] &&
      !packageLock.packages?.[""]?.devDependencies?.["@bitwarden/commercial-sdk-internal"] &&
      !Object.keys(packageLock.packages ?? {}).some(
        (key) =>
          key === "node_modules/@bitwarden/commercial-sdk-internal" ||
          key.startsWith("node_modules/@bitwarden/commercial-sdk-internal/"),
      ),
    "Commercial SDK dependency entered OSS clean-room lockfile",
  );
}

console.log(`Verified release lane ${branch} at ${head} with ${targetIds.length} OSS targets`);
