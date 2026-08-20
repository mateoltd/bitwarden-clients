#!/usr/bin/env node
import { git, patchId, policy, resolveCommit } from "./lib.mjs";

const partial = process.argv.includes("--partial");
const targetArg = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "HEAD";
const base = resolveCommit(policy.baseCommit);
const target = resolveCommit(targetArg);
const findings = [];

const branch = git(["branch", "--show-current"]).trim();
if (target === resolveCommit("HEAD") && branch !== policy.branch) {
  findings.push(`checked-out branch is ${branch}, expected ${policy.branch}`);
}
if (git(["merge-base", base, target]).trim() !== base)
  findings.push("history does not begin at pinned main");

const commits = git(["rev-list", "--reverse", "--first-parent", `${base}..${target}`])
  .trim()
  .split("\n")
  .filter(Boolean);
const merges = git(["rev-list", "--merges", `${base}..${target}`])
  .trim()
  .split("\n")
  .filter(Boolean);
const upstreamSync = policy.upstreamSync;
if (
  git(["merge-base", upstreamSync.sourceCommit, upstreamSync.upstreamCommit]).trim() !==
  upstreamSync.mergeBaseCommit
) {
  findings.push("configured upstream merge base differs");
}
const expectedMergeParents = `${upstreamSync.sourceCommit} ${upstreamSync.upstreamCommit}`;
const matchingMerges = merges.filter(
  (merge) => git(["show", "-s", "--format=%P", merge]).trim() === expectedMergeParents,
);
if (matchingMerges.length !== 1 || merges.length !== 1) {
  findings.push(
    `expected one exact upstream merge (${expectedMergeParents}), got ${merges.join(", ") || "none"}`,
  );
}
for (const commit of commits) {
  const subject = git(["show", "-s", "--format=%s", commit]).trim();
  if (
    !/^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|test)(?:\([^)]+\))?!?: .+/.test(subject)
  ) {
    findings.push(`non-conventional subject ${commit}: ${subject}`);
  }
}
for (const source of policy.sourceCommits) {
  try {
    git(["merge-base", "--is-ancestor", source, target], { stdio: "ignore" });
    findings.push(`source ancestry imported: ${source}`);
  } catch {
    // Expected: clean-state commits must not inherit either development branch.
  }
}

if (!partial) {
  const targetPatchIds = new Set(commits.map(patchId).filter(Boolean));
  for (const commit of policy.portabilityCommits) {
    const expected = patchId(commit);
    if (!targetPatchIds.has(expected))
      findings.push(`portability patch not replayed exactly: ${commit}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(
    `History verification failed\n${findings.map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `history ok: ${base}..${target}, ${commits.length} first-parent conventional commits, one exact upstream merge, no source ancestry${partial ? " (partial)" : ""}\n`,
  );
}
