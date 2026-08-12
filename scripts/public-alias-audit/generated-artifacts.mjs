#!/usr/bin/env node
import {
  blob,
  changedEntries,
  fail,
  parseRefs,
  pathMatches,
  policy,
  sha256,
  treeEntries,
} from "./lib.mjs";

const { base, target } = parseRefs();
const findings = [];
const targetTree = new Map(treeEntries(target).map((entry) => [entry.path, entry]));

for (const change of changedEntries(base, target)) {
  if (change.status[0] === "D") continue;
  if (pathMatches(change.path, policy.generatedPathPatterns)) {
    findings.push(`generated/cache path tracked: ${change.path}`);
  }
  const entry = targetTree.get(change.path);
  if (entry?.size > 5_000_000) {
    const expected = policy.allowedArtifacts[change.path];
    const actual = sha256(blob(target, change.path));
    if (!expected) findings.push(`large artifact is not allowlisted: ${change.path} (${entry.size} bytes)`);
    else if (actual !== expected) findings.push(`allowlisted artifact digest mismatch: ${change.path}`);
  }
}

for (const [path, expected] of Object.entries(policy.allowedArtifacts)) {
  const entry = targetTree.get(path);
  if (entry && sha256(blob(target, path)) !== expected) findings.push(`artifact digest mismatch: ${path}`);
}

fail("Generated-artifact scan failed", findings);
if (findings.length === 0) process.stdout.write(`generated-artifacts ok: ${base}..${target}\n`);
