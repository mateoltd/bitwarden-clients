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

const commits = git(["rev-list", "--reverse", `${base}..${target}`])
  .trim()
  .split("\n")
  .filter(Boolean);
const merges = git(["rev-list", "--merges", `${base}..${target}`]).trim();
if (merges) findings.push(`merge commits present: ${merges.replaceAll("\n", ", ")}`);
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
    `history ok: ${base}..${target}, ${commits.length} linear conventional commits, no source ancestry${partial ? " (partial)" : ""}\n`,
  );
}
