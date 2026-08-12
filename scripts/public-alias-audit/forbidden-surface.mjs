#!/usr/bin/env node
import { addedLines, changedEntries, fail, parseRefs, pathMatches, policy } from "./lib.mjs";

const { base, target } = parseRefs();
const findings = [];
for (const change of changedEntries(base, target)) {
  if (change.status[0] !== "D" && pathMatches(change.path, policy.forbiddenPathPatterns)) {
    findings.push(`forbidden path present: ${change.path}`);
  }
}
const textPatterns = policy.forbiddenAddedTextPatterns.map((pattern) => new RegExp(pattern, "i"));
for (const { path, text } of addedLines(base, target)) {
  if (path.startsWith("scripts/public-alias-audit/")) continue;
  for (const pattern of textPatterns) {
    if (pattern.test(text)) findings.push(`forbidden added surface in ${path}: ${pattern.source}`);
  }
}

fail("Forbidden-surface scan failed", findings);
if (findings.length === 0) process.stdout.write(`forbidden-surface ok: ${base}..${target}\n`);
