import fs from "node:fs";
import path from "node:path";

import {
  assert,
  git,
  parseArgs,
  readJson,
  readManifest,
  repositoryRoot,
  requireString,
  run,
  targetById,
  writeJson,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const targetId = requireString(args._[0], "release target ID is required");
const outputDirectory = path.resolve(
  repositoryRoot,
  requireString(args.output, "--output is required"),
);
const manifest = readManifest();
const target = targetById(manifest, targetId);

process.env.SOURCE_DATE_EPOCH ??= String(manifest.releaseLane.sourceDateEpoch);
run(process.execPath, ["scripts/release/verify-sdk.mjs"]);
if (process.env.OSS_CLEAN_ROOM === "1") {
  assert(
    !fs.existsSync(path.join(repositoryRoot, "bitwarden_license")),
    "Commercial source entered build",
  );
  assert(
    !fs.existsSync(path.join(repositoryRoot, "node_modules/@bitwarden/commercial-sdk-internal")),
    "Commercial SDK entered build",
  );
}

let payloadDirectory;
let version;

if (target.family === "browser") {
  run("npx", [
    "--no-install",
    "nx",
    "run",
    "browser:build",
    `--configuration=${target.configuration}`,
  ]);
  payloadDirectory = path.join(repositoryRoot, "dist/apps/browser", target.configuration);
  version = readJson(path.join(repositoryRoot, "apps/browser/package.json")).version;
} else if (target.family === "web") {
  run("npx", ["--no-install", "nx", "run", "web:build", `--configuration=${target.configuration}`]);
  payloadDirectory = path.join(repositoryRoot, "dist/apps/web/oss-selfhost");
  version = readJson(path.join(repositoryRoot, "apps/web/package.json")).version;
} else if (target.family === "cli") {
  const suffix = {
    "lin-x64": "lin",
    "lin-arm64": "lin-arm64",
    "mac-x64": "mac",
    "mac-arm64": "mac-arm64",
    "win-x64": "win",
  }[`${target.platform}-${target.architecture}`];
  assert(suffix, `Unsupported CLI host tuple: ${target.platform}-${target.architecture}`);
  run("npm", ["run", `dist:oss:${suffix}`, "--workspace", "apps/cli"]);
  const folder = {
    lin: "linux",
    "lin-arm64": "linux-arm64",
    mac: "macos",
    "mac-arm64": "macos-arm64",
    win: "windows",
  }[suffix];
  payloadDirectory = path.join(repositoryRoot, "apps/cli/dist/oss", folder);
  version = readJson(path.join(repositoryRoot, "apps/cli/package.json")).version;
} else if (target.family === "desktop") {
  process.env.CARGO_INCREMENTAL = "0";
  if (target.platform === "win") {
    const reproducibleLinkerFlag = "-C link-arg=/Brepro";
    process.env.RUSTFLAGS = [process.env.RUSTFLAGS, reproducibleLinkerFlag]
      .filter(Boolean)
      .join(" ");
  }
  run(process.execPath, [
    "apps/desktop/desktop_native/build.js",
    `--target=${target.rustTarget}`,
    "--release",
  ]);
  run("npm", ["run", "build", "--workspace", "apps/desktop"]);
  const builderArgs = [
    "--no-install",
    "electron-builder",
    "--dir",
    `--${target.platform}`,
    `--${target.architecture}`,
    "--publish",
    "never",
  ];
  if (target.platform === "mac") {
    builderArgs.push("-c.mac.identity=null");
  }
  run("npx", builderArgs, {
    cwd: path.join(repositoryRoot, "apps/desktop"),
    env: {
      RELEASE_CANDIDATE_UNSIGNED: "1",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    },
  });
  const directoryNames = {
    "linux-x64": ["linux-unpacked"],
    "linux-arm64": ["linux-arm64-unpacked"],
    "mac-x64": ["mac", "mac-x64"],
    "mac-arm64": ["mac-arm64", "mac"],
    "win-x64": ["win-unpacked"],
    "win-arm64": ["win-arm64-unpacked"],
    "win-ia32": ["win-ia32-unpacked"],
  }[`${target.platform}-${target.architecture}`];
  payloadDirectory = directoryNames
    .map((name) => path.join(repositoryRoot, "apps/desktop/dist", name))
    .find((candidate) => fs.existsSync(candidate));
  version = readJson(path.join(repositoryRoot, "apps/desktop/package.json")).version;
}

assert(
  payloadDirectory && fs.existsSync(payloadDirectory),
  `Build output is missing for ${target.id}`,
);
fs.mkdirSync(outputDirectory, { recursive: true });
const artifact = path.join(
  outputDirectory,
  `bitwarden-${target.id}-${version}.${target.artifactFormat}`,
);
run(process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3"), [
  "scripts/release/archive.py",
  "--source",
  payloadDirectory,
  "--output",
  artifact,
  "--format",
  target.artifactFormat,
  "--epoch",
  process.env.SOURCE_DATE_EPOCH,
]);
const sourceCommitFile = path.join(repositoryRoot, ".release-source-commit");
writeJson(`${artifact}.build.json`, {
  schemaVersion: 1,
  target: target.id,
  sourceCommit: fs.existsSync(sourceCommitFile)
    ? fs.readFileSync(sourceCommitFile, "utf8").trim()
    : (process.env.GITHUB_SHA ?? git(["rev-parse", "HEAD"])),
  sourceDateEpoch: Number(process.env.SOURCE_DATE_EPOCH),
  toolchains: manifest.toolchains,
  environment: {
    runnerOS: process.env.RUNNER_OS ?? process.platform,
    runnerArchitecture: process.env.RUNNER_ARCH ?? process.arch,
    runnerImage:
      [process.env.ImageOS, process.env.ImageVersion].filter(Boolean).join("-") || "local",
    node: process.version,
    npm: run("npm", ["--version"], { capture: true }),
  },
});
console.log(artifact);
