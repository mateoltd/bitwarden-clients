#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { scriptDirectory } from "./lib.mjs";

const partial = process.argv.includes("--partial");
const checks = [
  "tree-diff.mjs",
  "secret-scan.mjs",
  "license-scan.mjs",
  "forbidden-surface.mjs",
  "generated-artifacts.mjs",
  "history-verify.mjs",
];
let failed = false;
for (const check of checks) {
  const args = [resolve(scriptDirectory, check)];
  if (partial && check === "history-verify.mjs") args.push("--partial");
  const result = spawnSync(process.execPath, args, { cwd: process.cwd(), stdio: "inherit" });
  if (result.status !== 0) failed = true;
}
if (failed) process.exitCode = 1;
