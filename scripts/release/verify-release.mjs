import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { assert, git, readJson, readManifest, repositoryRoot, run } from "./lib.mjs";

run(process.execPath, ["scripts/release/verify-sdk.mjs"]);
const sdkInstallDirectories = ["sdk-internal", "alias-sdk-internal"].map((packageName) =>
  path.join(repositoryRoot, "node_modules/@bitwarden", packageName),
);
const installedSdkCount = sdkInstallDirectories.filter((directory) =>
  fs.existsSync(directory),
).length;
assert(
  installedSdkCount === 0 || installedSdkCount === sdkInstallDirectories.length,
  "SDK dependencies are only partially installed",
);
if (installedSdkCount === sdkInstallDirectories.length) {
  run(process.execPath, ["scripts/release/verify-sdk-install.mjs"]);
} else {
  console.log("Skipped physical SDK verification before dependency installation");
}
run(process.execPath, ["scripts/release/scope-audit.mjs"]);

const manifest = readManifest();
const headedWorkflow = fs.readFileSync(
  path.join(repositoryRoot, ".github/workflows/alias-headed-e2e.yml"),
  "utf8",
);
const releaseWorkflows = [
  ".github/workflows/alias-client-candidates.yml",
  ".github/workflows/alias-clean-room-rebuild.yml",
  ".github/workflows/alias-headed-e2e.yml",
  ".github/workflows/alias-upstream-drift.yml",
].map((relative) => [relative, fs.readFileSync(path.join(repositoryRoot, relative), "utf8")]);
for (const [relative, workflow] of releaseWorkflows) {
  assert(
    workflow.includes(`branches: [${manifest.releaseLane.branch}]`),
    `${relative} does not run for ${manifest.releaseLane.branch}`,
  );
}
assert(
  releaseWorkflows[0][1].includes(`SOURCE_DATE_EPOCH: ${manifest.releaseLane.sourceDateEpoch}`),
  "Candidate workflow source epoch does not match the release manifest",
);
const providerRepositoryUrl = new URL(manifest.testInfrastructure.simpleLogin.repository);
const providerRepository = providerRepositoryUrl.pathname.replace(/^\//, "").replace(/\.git$/, "");
assert(
  providerRepositoryUrl.protocol === "https:" && providerRepository.split("/").length === 2,
  "Provider test repository must be an exact public HTTPS repository",
);
for (const expected of [
  `default: ${providerRepository}`,
  `default: ${manifest.testInfrastructure.simpleLogin.operationsCommit}`,
  `default: ${manifest.testInfrastructure.simpleLogin.upstreamCommit}`,
]) {
  assert(
    headedWorkflow.includes(expected),
    `Headed provider workflow default is missing: ${expected}`,
  );
}
assert(
  headedWorkflow.includes("provider_repository:") &&
    headedWorkflow.includes("provider_operations_ref:") &&
    headedWorkflow.includes("provider_upstream_ref:"),
  "Headed provider repository and refs are not parameterizable",
);
const officialBitwarden = manifest.testInfrastructure.officialBitwarden;
assert(
  officialBitwarden.repository === "https://github.com/bitwarden/server.git" &&
    /^[0-9a-f]{40}$/.test(officialBitwarden.sourceCommit) &&
    officialBitwarden.image ===
      `ghcr.io/bitwarden/lite:${officialBitwarden.version}@sha256:ca1007fb3a8e973692ca1b92b87e52d2101976ef9bdf76d8639682485a5866dc`,
  "Official Bitwarden test server is not pinned to the maintained Lite image",
);
for (const expected of [
  officialBitwarden.image,
  manifest.testInfrastructure.vault.image,
  "bitwarden-test-service.mjs start-official",
  "verify-vaultwarden-rejection.mjs",
]) {
  assert(headedWorkflow.includes(expected), `Headed workflow is missing: ${expected}`);
}
const sourceCommitFile = path.join(repositoryRoot, ".release-source-commit");
let head;
let branch;
if (fs.existsSync(path.join(repositoryRoot, ".git"))) {
  head = git(["rev-parse", "HEAD"]);
  branch =
    git(["branch", "--show-current"]) || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  git(["merge-base", "--is-ancestor", manifest.releaseLane.baseCommit, head], { capture: false });
  const cleanCommits = git([
    "rev-list",
    "--reverse",
    "--first-parent",
    `${manifest.releaseLane.baseCommit}..${head}`,
  ])
    .split("\n")
    .filter(Boolean);
  assert(cleanCommits.length > 0, "Clean release history has no commits after the pinned base");
  assert(
    git(["rev-parse", `${cleanCommits[0]}^`]) === manifest.releaseLane.baseCommit,
    "First clean release commit is not parented directly by the pinned base",
  );
  const upstreamRebase = manifest.releaseLane.upstreamRebase;
  assert(
    upstreamRebase.strategy === "rebase-merges" &&
      upstreamRebase.upstreamCommit === manifest.releaseLane.baseCommit,
    "Release base does not match the configured rebase-merges upstream commit",
  );
  assert(
    git(["merge-base", upstreamRebase.sourceCommit, upstreamRebase.upstreamCommit]) ===
      upstreamRebase.sourceMergeBaseCommit,
    "Configured source merge base differs",
  );
  git(["merge-base", "--is-ancestor", upstreamRebase.upstreamCommit, head], { capture: false });
  for (const source of [
    upstreamRebase.sourceCommit,
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
  const downstreamTopology = manifest.releaseLane.downstreamTopology;
  const downstreamMerges = git([
    "rev-list",
    "--reverse",
    "--merges",
    `${upstreamRebase.upstreamCommit}..${head}`,
  ])
    .split("\n")
    .filter(Boolean);
  const downstreamMergeSubjects = downstreamMerges.map((merge) =>
    git(["show", "-s", "--format=%s", merge]),
  );
  assert(
    downstreamMerges.length === downstreamTopology.mergeCount &&
      downstreamMergeSubjects.every(
        (subject, index) => subject === downstreamTopology.mergeSubjects[index],
      ),
    `Unexpected downstream merge topology: ${downstreamMergeSubjects.join(", ") || "none"}`,
  );
  for (const merge of downstreamMerges) {
    const parents = git(["show", "-s", "--format=%P", merge]).split(/\s+/).filter(Boolean);
    assert(parents.length === 2, `Downstream merge ${merge} must have exactly two parents`);
    for (const parent of parents) {
      assert(
        parent !== upstreamRebase.upstreamCommit,
        `Downstream merge ${merge} directly imports the pinned upstream commit`,
      );
      git(["merge-base", "--is-ancestor", upstreamRebase.upstreamCommit, parent], {
        capture: false,
      });
    }
  }
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
const commercialOverlay = readJson(
  path.join(repositoryRoot, "release/commercial-sdk-overlay.json"),
);
assert(
  !rootPackage.dependencies?.["@bitwarden/commercial-sdk-internal"] &&
    !rootPackage.devDependencies?.["@bitwarden/commercial-sdk-internal"],
  "Commercial SDK dependency entered the public default package manifest",
);
assert(
  !packageLock.packages?.[""]?.dependencies?.["@bitwarden/commercial-sdk-internal"] &&
    !packageLock.packages?.[""]?.devDependencies?.["@bitwarden/commercial-sdk-internal"] &&
    !Object.keys(packageLock.packages ?? {}).some((key) =>
      key.startsWith("node_modules/@bitwarden/commercial-sdk-internal"),
    ),
  "Commercial SDK dependency entered the public default lockfile",
);
assert(
  commercialOverlay.schemaVersion === 1 &&
    commercialOverlay.graph === "commercial-overlay" &&
    commercialOverlay.package?.name === "@bitwarden/commercial-sdk-internal" &&
    commercialOverlay.package?.version === "0.2.0-main.950" &&
    commercialOverlay.package?.license === "BITWARDEN SOFTWARE DEVELOPMENT KIT LICENSE AGREEMENT" &&
    commercialOverlay.package?.repository === "https://github.com/bitwarden/sdk-internal.git" &&
    commercialOverlay.package?.registryTarball ===
      "https://registry.npmjs.org/@bitwarden/commercial-sdk-internal/-/commercial-sdk-internal-0.2.0-main.950.tgz" &&
    /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(commercialOverlay.package?.integrity ?? ""),
  "Commercial SDK overlay evidence is invalid",
);
assert(
  commercialOverlay.installCommand === "node scripts/release/commercial-sdk-overlay.mjs --install",
  "Commercial SDK overlay is not explicitly installable",
);
const publicCommercialImports = ["apps", "libs"].flatMap((directory) =>
  fs
    .readdirSync(path.join(repositoryRoot, directory), { recursive: true })
    .filter((entry) => /\.(?:[cm]?[jt]sx?|json)$/.test(entry))
    .filter((entry) => fs.statSync(path.join(repositoryRoot, directory, entry)).isFile())
    .filter((entry) =>
      fs
        .readFileSync(path.join(repositoryRoot, directory, entry), "utf8")
        .includes("@bitwarden/commercial-sdk-internal"),
    )
    .map((entry) => `${directory}/${entry}`),
);
assert(
  publicCommercialImports.length === 0,
  `Public source imports the commercial SDK: ${publicCommercialImports.join(", ")}`,
);
if (fs.existsSync(path.join(repositoryRoot, "bitwarden_license"))) {
  for (const consumer of commercialOverlay.consumers ?? []) {
    const consumerFile = path.join(repositoryRoot, consumer);
    assert(
      fs.existsSync(consumerFile) &&
        fs.readFileSync(consumerFile, "utf8").includes("@bitwarden/commercial-sdk-internal"),
      `Commercial overlay consumer is missing: ${consumer}`,
    );
  }
}
assert(
  rootPackage.packageManager === `npm@${manifest.clientToolchain.npm}`,
  "packageManager does not match the release manifest",
);
assert(
  fs.readFileSync(path.join(repositoryRoot, ".nvmrc"), "utf8").trim() ===
    `v${manifest.clientToolchain.node}`,
  "Root Node pin does not match the release manifest",
);
assert(
  fs.readFileSync(path.join(repositoryRoot, "apps/cli/.nvmrc"), "utf8").trim() ===
    `v${manifest.clientToolchain.cliNode}`,
  "CLI Node pin does not match the release manifest",
);
assert(
  fs.readFileSync(path.join(repositoryRoot, ".python-version"), "utf8").trim() ===
    manifest.clientToolchain.python,
  "Python pin does not match the release manifest",
);
assert(
  readJson(path.join(repositoryRoot, "release/tooling/package.json")).packageManager ===
    `npm@${manifest.clientToolchain.npm}`,
  "Release tooling npm pin does not match the release manifest",
);
const rustToolchain = fs.readFileSync(
  path.join(repositoryRoot, "apps/desktop/desktop_native/rust-toolchain.toml"),
  "utf8",
);
assert(
  rustToolchain.includes(`channel = "${manifest.clientToolchain.rust}"`),
  "Rust pin does not match the release manifest",
);
const electronBuilder = readJson(path.join(repositoryRoot, "apps/desktop/electron-builder.json"));
assert(
  electronBuilder.electronVersion === manifest.clientToolchain.electron,
  "Electron pin does not match the release manifest",
);
assert(
  rootPackage.devDependencies["electron-builder"] === manifest.clientToolchain.electronBuilder,
  "electron-builder pin does not match the release manifest",
);
assert(
  rootPackage.devDependencies.playwright === manifest.clientToolchain.playwright,
  "Playwright pin does not match the release manifest",
);
const chromiumRuntime = manifest.testInfrastructure.chromium;
assert(
  chromiumRuntime.playwrightVersion === manifest.clientToolchain.playwright,
  "Chromium runtime Playwright version does not match the toolchain pin",
);
assert(/^\d+$/.test(chromiumRuntime.revision), "Chromium runtime revision is invalid");
assert(/^\d+\.\d+\.\d+\.\d+$/.test(chromiumRuntime.version), "Chromium runtime version is invalid");
assert(
  chromiumRuntime.url ===
    `https://cdn.playwright.dev/builds/cft/${chromiumRuntime.version}/linux64/chrome-linux64.zip`,
  "Chromium runtime URL does not match its version pin",
);
assert(
  Number.isSafeInteger(chromiumRuntime.bytes) && chromiumRuntime.bytes > 0,
  "Chromium runtime size is invalid",
);
assert(/^[0-9a-f]{64}$/.test(chromiumRuntime.sha256), "Chromium runtime SHA-256 is invalid");

const toolchainDockerfile = fs.readFileSync(
  path.join(repositoryRoot, "scripts/release/pinned-toolchain.Dockerfile"),
  "utf8",
);
for (const image of Object.values(manifest.testInfrastructure.pinnedToolchain.containerImages)) {
  assert(toolchainDockerfile.includes(image), `Pinned toolchain Dockerfile is missing ${image}`);
}
assert(
  toolchainDockerfile.includes(`npm install --global npm@${manifest.clientToolchain.npm}`),
  "Pinned toolchain Dockerfile npm version differs from the manifest",
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
}

console.log(`Verified release lane ${branch} at ${head} with ${targetIds.length} OSS targets`);
