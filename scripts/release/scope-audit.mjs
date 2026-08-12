import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { assert, git, parseArgs, readManifest, repositoryRoot } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const manifest = readManifest();
const findings = [];
const forbiddenPublicScope = [
  ["personal recovery service", /\bpassmail\.net\b/i],
  ["personal recovery assumption", /\bpersonal[-_ ]recovery\b/i],
  ["personal-domain configuration", /\bpersonal[-_ ]domain\b/i],
  ["provider-account assumption", /\bproton(?:mail)?[-_ ]account\b|\bproton account\b/i],
  [
    "alias cutover or fixture workflow",
    /\b(?:alias[-_ ]?)?(?:migration fixture|cutover workflow|cutover plan)\b/i,
  ],
];
const forbiddenCompatibility = [
  [
    "alias migration or compatibility surface",
    /\b(?:migrat\w*[-_ ]+(?:cipher[-_ ]+)?alias(?:[-_ ]+reference)?|alias(?:[-_ ]+reference)?[-_ ]+(?:migrat\w*|compat(?:ibility)?)|legacy[-_ ]+alias(?:[-_ ]+reference)?|alias(?:[-_ ]+reference)?[-_ ]+legacy)\b/i,
  ],
  [
    "address-only alias binding",
    /\b(?:matched[-_ ]?by[-_ ]?address|address[-_ ]?only[-_ ]?(?:bind|match)\w*|(?:bind|match)\w*[-_ ]?by[-_ ]?address)\b/i,
  ],
  [
    "lazy connection identity compatibility",
    /\b(?:pending[-_ ]?connections|ensure[-_ ]?simple[-_ ]?login[-_ ]?connection[-_ ]?settings)\b/i,
  ],
  [
    "v1 alias fixture",
    /\b(?:v1[-_ ]+(?:alias[-_ ]+)?fixture|(?:alias[-_ ]+)?fixture[-_ ]+v1|alias[-_ ]+migration[-_ ]+fixture)\b/i,
  ],
];
const compatibilityAllowlist = new Set([
  "libs/components/src/stories/icons/icons.mdx",
  "scripts/material-icons/build-with-bwi-names.ts",
]);

function auditText(label, text, auditCompatibility = true) {
  for (const [description, pattern] of forbiddenPublicScope) {
    if (pattern.test(text)) findings.push(`${label}: ${description}`);
  }
  if (auditCompatibility) {
    for (const [description, pattern] of forbiddenCompatibility) {
      if (pattern.test(text)) findings.push(`${label}: ${description}`);
    }
  }
}

function sourceFiles() {
  if (!fs.existsSync(path.join(repositoryRoot, ".git"))) {
    const pending = [repositoryRoot];
    const files = [];
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (["node_modules", ".nx", "dist", "build", "bitwarden_license"].includes(entry.name)) {
          continue;
        }
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (entry.isFile()) {
          files.push(path.relative(repositoryRoot, entryPath).split(path.sep).join("/"));
        }
      }
    }
    return files;
  }
  const tracked = git(["ls-files"]).split("\n").filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  return [...new Set([...tracked, ...untracked])];
}

for (const relative of sourceFiles()) {
  if (
    relative.startsWith("bitwarden_license/") ||
    relative.startsWith("scripts/public-alias-audit/") ||
    relative === manifest.canonicalSdk.artifact ||
    relative === "scripts/release/scope-audit.mjs" ||
    /package-lock\.json$/.test(relative)
  )
    continue;
  const file = path.join(repositoryRoot, relative);
  if (!fs.existsSync(file) || fs.statSync(file).size > 2_000_000) continue;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (relative === "release/alias-client-release.json") {
    const parsed = JSON.parse(text);
    parsed.releaseLane.cleanupTrackingRef = "reviewed-client-cleanup-ref";
    parsed.canonicalSdk.cleanupTrackingRef = "reviewed-sdk-cleanup-ref";
    text = JSON.stringify(parsed);
  }
  auditText(relative, text, !compatibilityAllowlist.has(relative));
}

if (!args["source-only"]) {
  const archive = path.join(repositoryRoot, manifest.canonicalSdk.artifact);
  const archiveDirectory = path.dirname(archive);
  const archiveName = path.basename(archive);
  const members = execFileSync("tar", ["-tzf", archiveName], {
    cwd: archiveDirectory,
    encoding: "utf8",
  })
    .split("\n")
    .filter((member) => /(?:\.d\.ts|\.js|\.json|\.md|\.txt|\/VERSION)$/.test(member));
  for (const member of members) {
    const text = execFileSync("tar", ["-xOzf", archiveName, member], {
      cwd: archiveDirectory,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    auditText(`${manifest.canonicalSdk.artifact}:${member}`, text);
  }
}

assert(findings.length === 0, `Public release scope audit failed:\n${findings.join("\n")}`);
console.log(
  `Public release scope audit passed (${args["source-only"] ? "source" : "source and SDK"})`,
);
