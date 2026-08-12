#!/usr/bin/env node
import { blob, changedEntries, parseRefs, resolveCommit, sha256, treeEntries } from "./lib.mjs";

const { base, target } = parseRefs();
const targetTree = new Map(treeEntries(target).map((entry) => [entry.path, entry]));
const changes = changedEntries(base, target).map((change) => {
  const entry = targetTree.get(change.path);
  return {
    ...change,
    ...(entry ?? {}),
    sha256: entry?.type === "blob" ? sha256(blob(target, change.path)) : null,
  };
});
const counts = Object.groupBy(changes, (entry) => entry.status[0]);

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      base: resolveCommit(base),
      target: resolveCommit(target),
      counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value.length])),
      changes,
    },
    null,
    2,
  )}\n`,
);
