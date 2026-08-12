#!/usr/bin/env node
import { readFileSync } from "node:fs";

import {
  blob,
  changedEntries,
  fail,
  objectId,
  policy,
  resolveCommit,
  sha256,
  treeEntries,
} from "./lib.mjs";

const args = process.argv.slice(2);
const base = resolveCommit(args.shift() ?? policy.baseCommit);
const target = resolveCommit(args.shift() ?? "HEAD");
const manifestFlag = args.indexOf("--manifest");
const manifestPath = manifestFlag >= 0 ? args[manifestFlag + 1] : undefined;
const findings = [];

for (const path of policy.requiredUpstreamPaths) {
  if (!objectId(target, path)) findings.push(`required upstream path is missing: ${path}`);
}
for (const path of policy.protectedUpstreamPaths) {
  const before = objectId(base, path);
  const after = objectId(target, path);
  if (before !== after) findings.push(`protected upstream tree changed: ${path}`);
}

if (manifestPath) {
  const expected = JSON.parse(readFileSync(manifestPath, "utf8"));
  const actual = new Map(
    treeEntries(target).map((entry) => [
      entry.path,
      entry.type === "blob" ? sha256(blob(target, entry.path)) : entry.object,
    ]),
  );
  for (const [path, digest] of Object.entries(expected.files ?? {})) {
    if (actual.get(path) !== digest) findings.push(`tree manifest mismatch: ${path}`);
    actual.delete(path);
  }
  for (const path of actual.keys()) findings.push(`tree manifest has no entry for: ${path}`);
}

fail("Tree-diff verification failed", findings);
if (findings.length === 0) {
  const changes = changedEntries(base, target);
  process.stdout.write(
    `tree-diff ok: ${base}..${target}, ${changes.length} changed paths, protected import/export trees unchanged\n`,
  );
}
