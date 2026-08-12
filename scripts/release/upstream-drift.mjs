import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { git, parseArgs, readManifest, repositoryRoot, run } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const manifest = readManifest();
const output = path.resolve(repositoryRoot, args.output ?? "upstream-compatibility-report.md");
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "alias-upstream-drift-"));

function remoteCommit(repository, reference) {
  const line = run("git", ["ls-remote", repository, reference], { capture: true });
  return line ? line.split(/\s+/)[0] : null;
}

function changedFiles(cwd, before, after) {
  return git(["diff", "--name-only", `${before}...${after}`], { cwd })
    .split("\n")
    .filter(Boolean);
}

function important(files) {
  return files.filter(
    (file) =>
      /(^|\/)(alias|sdk|release|provider|cipher|autofill)/i.test(file) ||
      /(^|\/)(package-lock\.json|Cargo\.lock)$/.test(file) ||
      file.startsWith(".github/workflows/"),
  );
}

function bullets(values) {
  return values.length ? values.map((value) => `- \`${value}\``).join("\n") : "- None detected";
}

try {
  const upstreamCommit = remoteCommit(
    manifest.releaseLane.upstreamRepository,
    manifest.releaseLane.upstreamRef,
  );
  const clientCleanupCommit = remoteCommit(
    manifest.releaseLane.sourceRepository,
    manifest.releaseLane.cleanupTrackingRef,
  );
  const sdkTrackingCommit = remoteCommit(
    manifest.canonicalSdk.sourceRepository,
    manifest.canonicalSdk.trackingRef,
  );
  const sdkCleanupCommit = remoteCommit(
    manifest.canonicalSdk.sourceRepository,
    manifest.canonicalSdk.cleanupTrackingRef,
  );

  let upstreamFiles = [];
  let releaseFiles = [];
  let overlap = [];
  let aheadBehind = "unavailable";
  if (upstreamCommit) {
    git(
      [
        "fetch",
        "--no-tags",
        manifest.releaseLane.upstreamRepository,
        manifest.releaseLane.upstreamRef,
      ],
      {
        capture: false,
      },
    );
    const fetched = git(["rev-parse", "FETCH_HEAD"]);
    const mergeBase = git(["merge-base", "HEAD", fetched]);
    upstreamFiles = changedFiles(repositoryRoot, mergeBase, fetched);
    releaseFiles = git(["diff", "--name-only", `${manifest.releaseLane.baseCommit}..HEAD`])
      .split("\n")
      .filter(Boolean);
    const upstreamSet = new Set(upstreamFiles);
    overlap = releaseFiles.filter((file) => upstreamSet.has(file));
    aheadBehind = git(["rev-list", "--left-right", "--count", `HEAD...${fetched}`]).replace(
      "\t",
      " / ",
    );
  }

  let sdkFiles = [];
  let sdkBuildDeltaFiles = [];
  if (
    (sdkTrackingCommit && sdkTrackingCommit !== manifest.canonicalSdk.sourceCommit) ||
    manifest.canonicalSdk.functionalCleanupCommit !== manifest.canonicalSdk.sourceCommit
  ) {
    const sdkDirectory = path.join(temporaryDirectory, "sdk");
    run("git", [
      "clone",
      "--quiet",
      "--filter=blob:none",
      "--no-checkout",
      manifest.canonicalSdk.sourceRepository,
      sdkDirectory,
    ]);
    const sdkCommits = [
      manifest.canonicalSdk.functionalCleanupCommit,
      manifest.canonicalSdk.sourceCommit,
      sdkTrackingCommit,
    ].filter((commit, index, commits) => commit && commits.indexOf(commit) === index);
    run("git", ["-C", sdkDirectory, "fetch", "--quiet", "origin", ...sdkCommits]);
    sdkBuildDeltaFiles = run(
      "git",
      [
        "-C",
        sdkDirectory,
        "diff",
        "--name-only",
        `${manifest.canonicalSdk.functionalCleanupCommit}..${manifest.canonicalSdk.sourceCommit}`,
      ],
      { capture: true },
    )
      .split("\n")
      .filter(Boolean);
    if (sdkTrackingCommit && sdkTrackingCommit !== manifest.canonicalSdk.sourceCommit) {
      sdkFiles = run(
        "git",
        [
          "-C",
          sdkDirectory,
          "diff",
          "--name-only",
          `${manifest.canonicalSdk.sourceCommit}..${sdkTrackingCommit}`,
        ],
        { capture: true },
      )
        .split("\n")
        .filter(Boolean);
    }
  }

  const risk =
    overlap.length ||
    important(upstreamFiles).length ||
    important(sdkFiles).length ||
    clientCleanupCommit !== manifest.releaseLane.cleanupCommit ||
    sdkCleanupCommit !== manifest.canonicalSdk.sourceCommit
      ? "review required"
      : "low observed drift";
  const report = [
    "# Alias client upstream compatibility report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Assessment: **${risk}**`,
    "",
    "## Pinned state",
    "",
    `- Client release HEAD: \`${git(["rev-parse", "HEAD"])}\``,
    `- Required base: \`${manifest.releaseLane.baseCommit}\``,
    `- Integrated client cleanup: \`${manifest.releaseLane.cleanupCommit}\``,
    `- Canonical SDK artifact build: \`${manifest.canonicalSdk.sourceCommit}\` (${manifest.canonicalSdk.sha256})`,
    `- Canonical SDK functional cleanup: \`${manifest.canonicalSdk.functionalCleanupCommit}\``,
    "",
    "## Available upstream state",
    "",
    `- Bitwarden client ${manifest.releaseLane.upstreamRef}: ${upstreamCommit ? `\`${upstreamCommit}\`` : "missing"}`,
    `- Client cleanup ${manifest.releaseLane.cleanupTrackingRef}: ${clientCleanupCommit ? `\`${clientCleanupCommit}\`` : "not available"}`,
    `- Canonical SDK ${manifest.canonicalSdk.trackingRef}: ${sdkTrackingCommit ? `\`${sdkTrackingCommit}\`` : "missing"}`,
    `- SDK cleanup ${manifest.canonicalSdk.cleanupTrackingRef}: ${sdkCleanupCommit ? `\`${sdkCleanupCommit}\`` : "not available"}`,
    `- Client HEAD left/right count versus upstream: ${aheadBehind}`,
    "",
    "## Exact-path overlap",
    "",
    bullets(overlap),
    "",
    "## Relevant upstream client changes",
    "",
    bullets(important(upstreamFiles)),
    "",
    "## Relevant canonical SDK changes",
    "",
    bullets(important(sdkFiles)),
    "",
    "## SDK build-only delta",
    "",
    bullets(sdkBuildDeltaFiles),
    "",
    "## Required operator actions",
    "",
    "1. Review every exact-path overlap and relevant alias, SDK, cipher, autofill, lockfile, and workflow change above.",
    "2. Download and extract the complete cleaned SDK workflow candidate, then repin it with:",
    "",
    "   `npm run release:sdk:repin -- --candidate /absolute/path/extracted-candidate --source-commit BUILD_COMMIT --functional-commit FUNCTIONAL_COMMIT`",
    "",
    "3. Run `npm run release:verify`, the candidate matrix, headed provider tests, and clean-room rebuilds.",
    "4. Update the pinned base only through a reviewed commit. This report never merges, rebases, force-pushes, or rewrites history.",
    "",
  ].join("\n");
  fs.writeFileSync(output, report);
  console.log(output);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
