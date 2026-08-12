import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { assert, parseArgs, repositoryRoot, requireString } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const input = path.resolve(
  repositoryRoot,
  requireString(args._[0], "license-checker JSON is required"),
);
const output = args.output ? path.resolve(repositoryRoot, args.output) : undefined;
const packages = JSON.parse(fs.readFileSync(input, "utf8"));
const require = createRequire(import.meta.url);
const parseSpdx = require("../../release/tooling/node_modules/spdx-expression-parse");
const spdxLicenseIds = new Set(require("../../release/tooling/node_modules/spdx-license-ids"));
for (const license of require("../../release/tooling/node_modules/spdx-license-ids/deprecated")) {
  spdxLicenseIds.add(license);
}
const failures = [];
const reviewed = [];
const reviewedExpressions = new Map([
  ["callsite@1.0.0", "MIT"],
  ["pause-stream@0.0.11", "MIT OR Apache-2.0"],
]);
const deniedTerms =
  /(AGPL|BUSL|Business Source|Commons Clause|SSPL|PolyForm|UNLICENSED|UNKNOWN|SEE LICENSE)/i;

function licenseIds(node) {
  if (node.license) return [node.license];
  return [...licenseIds(node.left), ...licenseIds(node.right)];
}

function isRecognized(expression) {
  if (/^(BSD|Public Domain|UNLICENSE|BlueOak[- ]|WTFPL)$/i.test(expression)) return true;
  try {
    return licenseIds(parseSpdx(expression)).every((license) => spdxLicenseIds.has(license));
  } catch {
    return false;
  }
}

for (const [name, details] of Object.entries(packages)) {
  const declaredLicense = String(details.licenses ?? "UNKNOWN");
  const license = reviewedExpressions.get(name) ?? declaredLicense;
  if (name.startsWith("@bitwarden/commercial-sdk-internal@")) {
    failures.push(`${name}: commercial package is outside the OSS boundary`);
  } else if (deniedTerms.test(license) || !isRecognized(license)) {
    failures.push(`${name}: unapproved or unknown license expression ${license}`);
  }
  reviewed.push({
    name,
    license,
    declaredLicense,
    reviewedOverride: reviewedExpressions.has(name),
    repository: details.repository ?? null,
  });
}

const report = {
  schemaVersion: 1,
  policy: "Public OSS candidates: recognized open-source licenses only; no commercial SDK package",
  packageCount: reviewed.length,
  failures,
  packages: reviewed,
};
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
assert(failures.length === 0, `License policy failed:\n${failures.join("\n")}`);
console.log(`License policy passed for ${reviewed.length} packages`);
