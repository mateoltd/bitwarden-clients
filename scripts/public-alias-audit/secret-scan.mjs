#!/usr/bin/env node
import { addedLines, fail, parseRefs } from "./lib.mjs";

const { base, target } = parseRefs();
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  [
    "assigned credential",
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["'][^"']{16,}["']/i,
  ],
];
const obviousFixture =
  /(?:example|fixture|placeholder|must-not-leak|test-token|generated-password|account-password|alias-lab-password)/i;
const findings = [];

for (const { path, text } of addedLines(base, target)) {
  if (/^(?:package-lock\.json|release\/tooling\/package-lock\.json)$/.test(path)) continue;
  for (const [label, pattern] of patterns) {
    if (pattern.test(text) && !obviousFixture.test(text)) findings.push(`${path}: ${label}`);
  }
}

fail("Secret scan failed", findings);
if (findings.length === 0) process.stdout.write(`secret-scan ok: ${base}..${target}\n`);
