#!/usr/bin/env node
import { fail, git, objectId, parseRefs, policy } from "./lib.mjs";

const { base, target } = parseRefs();
const findings = [];
const protectedLicenses = ["LICENSE.txt", "LICENSE_BITWARDEN.txt", "LICENSE_GPL.txt"];

for (const path of protectedLicenses) {
  if (objectId(base, path) !== objectId(target, path)) findings.push(`root license changed: ${path}`);
}

function jsonAt(ref, path) {
  return JSON.parse(git(["show", `${ref}:${path}`]));
}

const allowed = policy.allowedLicensePatterns.map((pattern) => new RegExp(pattern, "i"));
for (const lockPath of ["package-lock.json", "release/tooling/package-lock.json"]) {
  if (!objectId(target, lockPath)) continue;
  const before = objectId(base, lockPath) ? jsonAt(base, lockPath).packages ?? {} : {};
  const after = jsonAt(target, lockPath).packages ?? {};
  for (const [name, metadata] of Object.entries(after)) {
    if (before[name] || name === "" || metadata.link || String(metadata.resolved ?? "").startsWith("file:")) {
      continue;
    }
    const license = String(metadata.license ?? "").trim();
    if (!license) {
      findings.push(`${lockPath}: added package lacks a declared license: ${name}`);
    } else if (!allowed.some((pattern) => pattern.test(license))) {
      findings.push(`${lockPath}: disallowed or unreviewed license ${license}: ${name}`);
    }
  }
}

const rootPackage = jsonAt(target, "package.json");
if (!/^GPL-3\.0/.test(rootPackage.license ?? "")) findings.push("root package is not GPL-3.0 licensed");

fail("License scan failed", findings);
if (findings.length === 0) process.stdout.write(`license-scan ok: ${base}..${target}\n`);
