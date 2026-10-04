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
if (git(["merge-base", base, target]).trim() !== base) {
  findings.push("history does not descend from pinned upstream main");
}

const commits = git(["rev-list", "--reverse", `${base}..${target}`])
  .trim()
  .split("\n")
  .filter(Boolean);
const merges = git(["rev-list", "--reverse", "--merges", `${base}..${target}`])
  .trim()
  .split("\n")
  .filter(Boolean);
const upstreamRebase = policy.upstreamRebase;
if (base !== resolveCommit(upstreamRebase.upstreamCommit)) {
  findings.push("pinned history base differs from the configured upstream rebase commit");
}
if (
  git(["merge-base", upstreamRebase.sourceCommit, upstreamRebase.upstreamCommit]).trim() !==
  upstreamRebase.sourceMergeBaseCommit
) {
  findings.push("configured source merge base differs");
}
if (git(["merge-base", upstreamRebase.upstreamCommit, target]).trim() !== base) {
  findings.push("target does not contain the configured upstream rebase commit");
}

const expectedMergeSubjects = policy.downstreamTopology.mergeSubjects;
const mergeSubjects = merges.map((merge) => git(["show", "-s", "--format=%s", merge]).trim());
if (
  merges.length !== policy.downstreamTopology.mergeCount ||
  mergeSubjects.some((subject, index) => subject !== expectedMergeSubjects[index])
) {
  findings.push(
    `expected downstream merge subjects ${expectedMergeSubjects.join(", ")}, got ${mergeSubjects.join(", ") || "none"}`,
  );
}
for (const merge of merges) {
  const parents = git(["show", "-s", "--format=%P", merge]).trim().split(/\s+/).filter(Boolean);
  if (parents.length !== 2)
    findings.push(`downstream merge has ${parents.length} parents: ${merge}`);
  for (const parent of parents) {
    if (git(["merge-base", base, parent]).trim() !== base) {
      findings.push(`downstream merge parent does not descend from pinned upstream: ${parent}`);
    }
    if (parent === base)
      findings.push(`downstream merge directly imports pinned upstream: ${merge}`);
  }
}
for (const commit of commits) {
  const subject = git(["show", "-s", "--format=%s", commit]).trim();
  if (
    !expectedMergeSubjects.includes(subject) &&
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
    `history ok: ${base}..${target}, ${commits.length} downstream commits, ${merges.length} preserved downstream merge, no source ancestry${partial ? " (partial)" : ""}\n`,
  );
}
