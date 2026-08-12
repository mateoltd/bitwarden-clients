#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_POLICY = "scripts/upstream-sync-audit/policy.json";
const DEFAULT_OUTPUT = ".artifacts/upstream-sync-audit";
const SOURCE_FILE = /\.(?:c|cc|cpp|cxx|h|hpp|html|js|jsx|json|jsonc|mjs|cjs|rs|swift|kt|kts|ts|tsx|toml|yaml|yml)$/i;

function isOid(value) {
  return /^[0-9a-f]{40,64}$/.test(value);
}

function usage() {
  return `Usage: node scripts/upstream-sync-audit/audit.mjs [options]

Compare an upstream commit with a fork commit without checking out or merging either ref.

Options:
  --upstream <ref>    Upstream ref already present locally (default: upstream/main)
  --fork <ref>        Fork ref to audit (default: HEAD)
  --base <ref>        Explicit common ancestor (default: git merge-base)
  --repo <path>       Git worktree to inspect (default: current worktree)
  --policy <path>     Policy JSON, relative to the worktree by default
  --output-dir <path> Report directory (default: ${DEFAULT_OUTPUT})
  --dry-run           Print the Markdown report and do not write reports
  --help              Show this help

Exit codes:
  0  Audit completed without an unallowlisted policy violation
  1  One or more explicit policy violations were found
  2  Invalid input, policy, or Git state prevented the audit
`;
}

function parseArgs(argv) {
  const options = {
    upstream: process.env.UPSTREAM_REF || "upstream/main",
    fork: process.env.FORK_REF || "HEAD",
    base: process.env.BASE_REF || null,
    repo: process.cwd(),
    policy: DEFAULT_POLICY,
    outputDir: DEFAULT_OUTPUT,
    dryRun: false,
    help: false,
  };

  const valueOptions = new Map([
    ["--upstream", "upstream"],
    ["--fork", "fork"],
    ["--base", "base"],
    ["--repo", "repo"],
    ["--policy", "policy"],
    ["--output-dir", "outputDir"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    options[key] = value;
    index += 1;
  }

  return options;
}

function runGit(repo, args, allowedStatuses = [0]) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Unable to run git ${args[0]}: ${result.error.message}`);
  }
  if (!allowedStatuses.includes(result.status)) {
    const error = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
    throw new Error(`git ${args[0]} failed (${result.status}): ${error}`);
  }
  return result;
}

function gitText(repo, args, allowedStatuses = [0]) {
  return runGit(repo, args, allowedStatuses).stdout.toString("utf8");
}

function resolveCommit(repo, ref) {
  const value = gitText(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
  if (!isOid(value)) {
    throw new Error(`Ref did not resolve to a commit: ${ref}`);
  }
  return value;
}

function isAncestor(repo, ancestor, descendant) {
  return runGit(repo, ["merge-base", "--is-ancestor", ancestor, descendant], [0, 1]).status === 0;
}

function readPolicy(repo, policyOption) {
  const policyPath = path.isAbsolute(policyOption) ? policyOption : path.join(repo, policyOption);
  let raw;
  try {
    raw = fs.readFileSync(policyPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read policy ${policyPath}: ${error.message}`);
  }

  let policy;
  try {
    policy = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid policy JSON ${policyPath}: ${error.message}`);
  }
  validatePolicy(policy);
  return {
    policy,
    path: policyPath,
    displayPath: path.relative(repo, policyPath) || path.basename(policyPath),
    digest: createHash("sha256").update(raw).digest("hex"),
  };
}

function validatePolicy(policy) {
  if (policy.schemaVersion !== 1) {
    throw new Error(`Unsupported policy schemaVersion: ${policy.schemaVersion}`);
  }
  for (const key of [
    "scanExcludes",
    "commercialSourceRoots",
    "commercialReferencePatterns",
    "generatedArtifacts",
    "riskSurfaces",
    "forbiddenPaths",
    "forbiddenContent",
    "forbiddenDomains",
    "domainReviewAllowlist",
    "allowlist",
  ]) {
    if (!Array.isArray(policy[key])) {
      throw new Error(`Policy field ${key} must be an array`);
    }
  }

  for (const collection of [policy.forbiddenPaths, policy.forbiddenContent, policy.forbiddenDomains]) {
    for (const rule of collection) {
      if (!rule.id || !rule.pattern) {
        throw new Error("Every forbidden rule requires id and pattern");
      }
      try {
        new RegExp(rule.pattern, rule.flags || "");
      } catch (error) {
        throw new Error(`Invalid regular expression for ${rule.id}: ${error.message}`);
      }
    }
  }

  const fingerprints = new Set();
  for (const entry of policy.allowlist) {
    if (!entry.fingerprint || !entry.reason?.trim()) {
      throw new Error("Each allowlist entry requires an exact fingerprint and a non-empty reason");
    }
    if (fingerprints.has(entry.fingerprint)) {
      throw new Error(`Duplicate allowlist fingerprint: ${entry.fingerprint}`);
    }
    fingerprints.add(entry.fingerprint);
  }
}

function globToRegExp(glob) {
  let output = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        output += "(?:.*/)?";
      } else {
        output += ".*";
      }
    } else if (character === "*") {
      output += "[^/]*";
    } else if (character === "?") {
      output += "[^/]";
    } else {
      output += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${output}$`);
}

const globCache = new Map();

function matchesGlob(value, glob) {
  let expression = globCache.get(glob);
  if (!expression) {
    expression = globToRegExp(glob);
    globCache.set(glob, expression);
  }
  return expression.test(value);
}

function matchesAny(value, patterns = []) {
  return patterns.some((pattern) => matchesGlob(value, pattern));
}

function parseNameStatus(buffer) {
  const fields = buffer.toString("utf8").split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }
  const entries = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (/^[RC]/.test(status)) {
      const oldPath = fields[index++];
      const currentPath = fields[index++];
      entries.push({ status, path: currentPath, oldPath });
    } else {
      entries.push({ status, path: fields[index++] });
    }
  }
  return entries.sort(compareChangeEntries);
}

function compareChangeEntries(left, right) {
  return left.path.localeCompare(right.path) || left.status.localeCompare(right.status);
}

function changedFiles(repo, base, commit) {
  const result = runGit(repo, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    "--no-ext-diff",
    base,
    commit,
    "--",
  ]);
  return parseNameStatus(result.stdout);
}

function changedPathSet(entries) {
  const paths = new Set();
  for (const entry of entries) {
    paths.add(entry.path);
    if (entry.oldPath) {
      paths.add(entry.oldPath);
    }
  }
  return paths;
}

function mergeConflicts(repo, fork, upstream) {
  const result = runGit(
    repo,
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", fork, upstream],
    [0, 1],
  );
  const lines = result.stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const paths = isOid(lines[0]) ? lines.slice(1) : lines;
  if (result.status === 1 && paths.length === 0) {
    const detailed = runGit(
      repo,
      ["merge-tree", "--write-tree", "--name-only", "--messages", fork, upstream],
      [0, 1],
    ).stdout.toString("utf8");
    for (const match of detailed.matchAll(/CONFLICT .*? in (.+)$/gm)) {
      paths.push(match[1].trim());
    }
  }
  if (result.status === 1 && paths.length === 0) {
    throw new Error("Git reported a merge conflict but the conflicting paths could not be parsed");
  }
  return [...new Set(paths)].sort();
}

function blobId(repo, commit, filePath) {
  const result = runGit(
    repo,
    ["rev-parse", "--verify", "--end-of-options", `${commit}:${filePath}`],
    [0, 128],
  );
  return result.status === 0 ? result.stdout.toString("utf8").trim() : null;
}

function classifyOverlaps(repo, upstream, fork, upstreamChanges, forkChanges, conflicts, policy) {
  const upstreamPaths = changedPathSet(upstreamChanges);
  const forkPaths = changedPathSet(forkChanges);
  const conflictSet = new Set(conflicts);
  return [...upstreamPaths]
    .filter((filePath) => forkPaths.has(filePath))
    .sort()
    .map((filePath) => {
      let classification;
      if (conflictSet.has(filePath)) {
        classification = "merge-conflict";
      } else {
        const upstreamBlob = blobId(repo, upstream, filePath);
        const forkBlob = blobId(repo, fork, filePath);
        classification = upstreamBlob === forkBlob ? "identical-change" : "clean-overlap";
      }
      return {
        path: filePath,
        classification,
        riskSurfaces: riskSurfaceIds(filePath, policy),
      };
    });
}

function riskSurfaceIds(filePath, policy) {
  return policy.riskSurfaces
    .filter((surface) => matchesAny(filePath, surface.patterns))
    .map((surface) => surface.id)
    .sort();
}

function riskChanges(changesBySide, policy) {
  const results = [];
  for (const [side, entries] of Object.entries(changesBySide)) {
    for (const entry of entries) {
      for (const surface of policy.riskSurfaces) {
        if (matchesAny(entry.path, surface.patterns)) {
          results.push({
            surface: surface.id,
            severity: surface.severity,
            side,
            status: entry.status,
            path: entry.path,
          });
        }
      }
    }
  }
  return results.sort(
    (left, right) =>
      left.surface.localeCompare(right.surface) ||
      left.path.localeCompare(right.path) ||
      left.side.localeCompare(right.side),
  );
}

function parseGrepRecords(buffer, commit) {
  const records = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const pathEnd = buffer.indexOf(0, cursor);
    if (pathEnd === -1) break;
    const pathToken = buffer.subarray(cursor, pathEnd).toString("utf8");
    cursor = pathEnd + 1;
    const lineEnd = buffer.indexOf(0, cursor);
    if (lineEnd === -1) break;
    const lineNumber = Number.parseInt(buffer.subarray(cursor, lineEnd).toString("utf8"), 10);
    cursor = lineEnd + 1;
    const textEnd = buffer.indexOf(10, cursor);
    const end = textEnd === -1 ? buffer.length : textEnd;
    const text = buffer.subarray(cursor, end).toString("utf8");
    cursor = end + 1;
    const prefix = `${commit}:`;
    const filePath = pathToken.startsWith(prefix) ? pathToken.slice(prefix.length) : pathToken;
    records.push({ path: filePath, line: lineNumber, text });
  }
  return records;
}

function commercialReferences(repo, commit, policy) {
  const expression = `(?:${policy.commercialReferencePatterns.join(")|(?:")})`;
  // Keep the Git-side expression POSIX ERE-compatible, then apply the exact
  // configurable JavaScript expressions to each matching line below.
  const result = runGit(
    repo,
    ["grep", "-I", "-n", "-z", "-E", "(bitwarden_license/|@bitwarden/bit-)", commit, "--", "."],
    [0, 1],
  );
  if (result.status === 1) return [];

  const targetExpression = new RegExp(expression, "g");
  const references = new Map();
  for (const record of parseGrepRecords(result.stdout, commit)) {
    if (!SOURCE_FILE.test(record.path)) continue;
    if (matchesAny(record.path, policy.commercialSourceRoots)) continue;
    if (matchesAny(record.path, policy.scanExcludes)) continue;
    for (const match of record.text.matchAll(targetExpression)) {
      const target = match[0].replace(/^\.\.?\//, "");
      const key = `${record.path}\0${target}`;
      if (!references.has(key)) {
        references.set(key, { from: record.path, target, line: record.line });
      }
    }
  }
  return [...references.values()].sort(
    (left, right) => left.from.localeCompare(right.from) || left.target.localeCompare(right.target),
  );
}

function newCommercialReferences(baseline, candidate) {
  const known = new Set(baseline.map((entry) => `${entry.from}\0${entry.target}`));
  return candidate.filter((entry) => !known.has(`${entry.from}\0${entry.target}`));
}

function parseAddedLines(diffText) {
  const records = [];
  let currentPath = null;
  let nextLine = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ ")) {
      const value = line.slice(4);
      currentPath = value === "/dev/null" ? null : value.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/);
      nextLine = match ? Number.parseInt(match[1], 10) : 0;
      continue;
    }
    if (!currentPath || line.startsWith("diff --git ") || line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      records.push({ path: currentPath, line: nextLine, text: line.slice(1) });
      nextLine += 1;
    } else if (!line.startsWith("-") && !line.startsWith("\\ No newline")) {
      nextLine += 1;
    }
  }
  return records;
}

function addedLines(repo, base, commit) {
  const diff = gitText(repo, [
    "diff",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--find-renames",
    "--diff-filter=ACMR",
    base,
    commit,
    "--",
  ]);
  return parseAddedLines(diff);
}

function compileRule(rule) {
  const flags = (rule.flags || "").replaceAll("g", "");
  return new RegExp(rule.pattern, flags);
}

function findingFingerprint(ruleId, filePath, detail) {
  const digest = createHash("sha256")
    .update(JSON.stringify({ ruleId, path: filePath, detail }))
    .digest("hex")
    .slice(0, 16);
  return `${ruleId}:${digest}`;
}

function findingCollector() {
  const findings = new Map();
  return {
    add({ ruleId, level, path: filePath, detail, side, line = null }) {
      const key = JSON.stringify([ruleId, level, filePath, detail]);
      const existing = findings.get(key) || {
        ruleId,
        level,
        path: filePath,
        detail,
        sides: new Set(),
        locations: [],
      };
      existing.sides.add(side);
      if (line != null && !existing.locations.some((location) => location.side === side && location.line === line)) {
        existing.locations.push({ side, line });
      }
      findings.set(key, existing);
    },
    finalize(allowlist) {
      const allowed = new Map(allowlist.map((entry) => [entry.fingerprint, entry.reason]));
      const finalized = [...findings.values()].map((finding) => {
        const fingerprint = findingFingerprint(finding.ruleId, finding.path, finding.detail);
        return {
          ...finding,
          sides: [...finding.sides].sort(),
          locations: finding.locations.sort(
            (left, right) => left.side.localeCompare(right.side) || left.line - right.line,
          ),
          fingerprint,
          allowed: finding.level === "violation" && allowed.has(fingerprint),
          allowlistReason: allowed.get(fingerprint) || null,
        };
      });
      finalized.sort(
        (left, right) =>
          left.level.localeCompare(right.level) ||
          left.ruleId.localeCompare(right.ruleId) ||
          left.path.localeCompare(right.path) ||
          left.detail.localeCompare(right.detail),
      );
      return finalized;
    },
  };
}

function generatedArtifactChecks(changesBySide, policy, findings) {
  const results = [];
  for (const [side, changes] of Object.entries(changesBySide)) {
    for (const pair of policy.generatedArtifacts) {
      const sourceChanges = changes.filter((entry) => matchesAny(entry.path, pair.sourcePaths));
      const artifactChanges = changes.filter((entry) => matchesAny(entry.path, pair.artifactPaths));
      let state = "unchanged";
      if (sourceChanges.length > 0 && artifactChanges.length > 0) {
        state = "source-and-artifact-changed";
      } else if (sourceChanges.length > 0) {
        state = "source-only";
        if (pair.requireArtifactsWithSources) {
          findings.add({
            ruleId: "generated-source-without-artifact",
            level: "violation",
            path: pair.id,
            detail: sourceChanges.map((entry) => entry.path).sort().join(", "),
            side,
          });
        }
      } else if (artifactChanges.length > 0) {
        state = "artifact-only";
        findings.add({
          ruleId: "generated-artifact-without-source",
          level: "review",
          path: pair.id,
          detail: artifactChanges.map((entry) => entry.path).sort().join(", "),
          side,
        });
      }
      if (state !== "unchanged") {
        results.push({
          id: pair.id,
          side,
          state,
          sourceChanges: sourceChanges.map((entry) => entry.path).sort(),
          artifactChanges: artifactChanges.map((entry) => entry.path).sort(),
        });
      }
    }
  }
  return results.sort((left, right) => left.id.localeCompare(right.id) || left.side.localeCompare(right.side));
}

function scanForbiddenPaths(changesBySide, policy, findings) {
  for (const [side, changes] of Object.entries(changesBySide)) {
    for (const change of changes) {
      if (change.status.startsWith("D") || matchesAny(change.path, policy.scanExcludes)) continue;
      for (const rule of policy.forbiddenPaths) {
        const match = compileRule(rule).exec(change.path);
        if (match) {
          findings.add({
            ruleId: `forbidden-path:${rule.id}`,
            level: "violation",
            path: change.path,
            detail: match[0],
            side,
          });
        }
      }
    }
  }
}

function domainAllowed(domain, allowlist) {
  return allowlist.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

function extractDomains(text) {
  const domains = new Set();
  for (const match of text.matchAll(/\b(?:https?|wss?):\/\/([A-Za-z0-9.-]+)(?::\d+)?/g)) {
    domains.add(match[1].toLowerCase().replace(/\.$/, ""));
  }
  for (const match of text.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
    domains.add(match[1].toLowerCase().replace(/\.$/, ""));
  }
  return [...domains].sort();
}

function scanAddedContent(repo, base, commitsBySide, policy, findings) {
  const domains = [];
  for (const [side, commit] of Object.entries(commitsBySide)) {
    for (const record of addedLines(repo, base, commit)) {
      if (matchesAny(record.path, policy.scanExcludes)) continue;
      for (const rule of policy.forbiddenContent) {
        const match = compileRule(rule).exec(record.text);
        if (match) {
          findings.add({
            ruleId: `forbidden-content:${rule.id}`,
            level: "violation",
            path: record.path,
            detail: match[0],
            side,
            line: record.line,
          });
        }
      }

      for (const domain of extractDomains(record.text)) {
        if (domainAllowed(domain, policy.domainReviewAllowlist)) continue;
        const entry = { domain, side, path: record.path, line: record.line };
        domains.push(entry);
        let forbidden = false;
        for (const rule of policy.forbiddenDomains) {
          if (compileRule(rule).test(domain)) {
            forbidden = true;
            findings.add({
              ruleId: `forbidden-domain:${rule.id}`,
              level: "violation",
              path: record.path,
              detail: domain,
              side,
              line: record.line,
            });
          }
        }
        if (!forbidden) {
          findings.add({
            ruleId: "new-domain-review",
            level: "review",
            path: record.path,
            detail: domain,
            side,
            line: record.line,
          });
        }
      }
    }
  }
  const unique = new Map();
  for (const entry of domains) {
    unique.set(`${entry.domain}\0${entry.side}\0${entry.path}\0${entry.line}`, entry);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.domain.localeCompare(right.domain) ||
      left.path.localeCompare(right.path) ||
      left.side.localeCompare(right.side) ||
      left.line - right.line,
  );
}

function addCommercialFindings(baseReferences, referencesBySide, findings) {
  const addedBySide = {};
  for (const [side, references] of Object.entries(referencesBySide)) {
    const added = newCommercialReferences(baseReferences, references);
    addedBySide[side] = added;
    for (const reference of added) {
      findings.add({
        ruleId: "unexpected-commercial-reachability",
        level: "violation",
        path: reference.from,
        detail: reference.target,
        side,
        line: reference.line,
      });
    }
  }
  return addedBySide;
}

function addCommercialSourceFindings(changesBySide, policy, findings) {
  for (const change of changesBySide.fork) {
    if (matchesAny(change.path, policy.commercialSourceRoots)) {
      findings.add({
        ruleId: "fork-commercial-source-change",
        level: "violation",
        path: change.path,
        detail: change.status,
        side: "fork",
      });
    }
  }
}

function staleAllowlistEntries(policy, findings) {
  const present = new Set(findings.map((finding) => finding.fingerprint));
  return policy.allowlist
    .filter((entry) => !present.has(entry.fingerprint))
    .map((entry) => ({ fingerprint: entry.fingerprint, reason: entry.reason }))
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function markdownList(items, emptyText) {
  if (items.length === 0) return `${emptyText}\n`;
  return `${items.map((item) => `- ${item}`).join("\n")}\n`;
}

function renderMarkdown(report) {
  const lines = [
    "# Upstream compatibility audit",
    "",
    `Outcome: **${report.outcome.toUpperCase()}**`,
    "",
    "Only unallowlisted findings marked as policy violations affect the exit code. Conflicts and review findings are reported for intake review.",
    "",
    "## Compared commits",
    "",
    "| Role | Requested ref | Commit |",
    "| --- | --- | --- |",
    `| Base | ${markdownCell(report.refs.base.requested)} | \`${report.refs.base.commit}\` |`,
    `| Upstream | ${markdownCell(report.refs.upstream.requested)} | \`${report.refs.upstream.commit}\` |`,
    `| Fork | ${markdownCell(report.refs.fork.requested)} | \`${report.refs.fork.commit}\` |`,
    "",
    `Policy: \`${markdownCell(report.policy.path)}\` (SHA-256 \`${report.policy.sha256}\`)`,
    "",
    "## Summary",
    "",
    "| Measure | Count |",
    "| --- | ---: |",
    `| Upstream changed paths | ${report.summary.upstreamChangedPaths} |`,
    `| Fork changed paths | ${report.summary.forkChangedPaths} |`,
    `| Overlapping paths | ${report.summary.overlappingPaths} |`,
    `| Merge conflicts | ${report.summary.mergeConflicts} |`,
    `| High-risk changes | ${report.summary.highRiskChanges} |`,
    `| Policy violations | ${report.summary.policyViolations} |`,
    `| Allowlisted violations | ${report.summary.allowlistedViolations} |`,
    `| Review findings | ${report.summary.reviewFindings} |`,
    "",
    "## Policy violations",
    "",
  ];

  const violations = report.findings.filter((finding) => finding.level === "violation");
  if (violations.length === 0) {
    lines.push("No policy violations.", "");
  } else {
    lines.push("| State | Rule | Path | Sides | Fingerprint | Detail |", "| --- | --- | --- | --- | --- | --- |");
    for (const finding of violations) {
      lines.push(
        `| ${finding.allowed ? "allowlisted" : "violation"} | ${markdownCell(finding.ruleId)} | ${markdownCell(finding.path)} | ${finding.sides.join(", ")} | \`${finding.fingerprint}\` | ${markdownCell(finding.detail)} |`,
      );
      if (finding.allowed) {
        lines.push(`|  | Allowlist reason |  |  |  | ${markdownCell(finding.allowlistReason)} |`);
      }
    }
    lines.push("");
  }

  lines.push("## Merge conflicts and overlaps", "");
  if (report.overlap.length === 0) {
    lines.push("No paths changed on both sides.", "");
  } else {
    lines.push("| Classification | Path | Risk surfaces |", "| --- | --- | --- |");
    for (const entry of report.overlap) {
      lines.push(
        `| ${entry.classification} | ${markdownCell(entry.path)} | ${markdownCell(entry.riskSurfaces.join(", ") || "none")} |`,
      );
    }
    lines.push("");
  }

  lines.push("## High-risk surfaces", "");
  const highRisk = report.riskChanges.filter((entry) => entry.severity === "high");
  if (highRisk.length === 0) {
    lines.push("No high-risk paths changed.", "");
  } else {
    lines.push("| Surface | Side | Status | Path |", "| --- | --- | --- | --- |");
    for (const entry of highRisk) {
      lines.push(`| ${entry.surface} | ${entry.side} | ${entry.status} | ${markdownCell(entry.path)} |`);
    }
    lines.push("");
  }

  lines.push("## Generated artifact checks", "");
  if (report.generatedArtifacts.length === 0) {
    lines.push("No configured generator inputs or artifacts changed.", "");
  } else {
    lines.push("| Pair | Side | State | Sources | Artifacts |", "| --- | --- | --- | --- | --- |");
    for (const entry of report.generatedArtifacts) {
      lines.push(
        `| ${entry.id} | ${entry.side} | ${entry.state} | ${markdownCell(entry.sourceChanges.join(", ") || "none")} | ${markdownCell(entry.artifactChanges.join(", ") || "none")} |`,
      );
    }
    lines.push("");
  }

  const reviews = report.findings.filter((finding) => finding.level === "review");
  lines.push("## Review findings", "");
  if (reviews.length === 0) {
    lines.push("No additional review findings.", "");
  } else {
    lines.push("| Rule | Path | Sides | Detail |", "| --- | --- | --- | --- |");
    for (const finding of reviews) {
      lines.push(
        `| ${finding.ruleId} | ${markdownCell(finding.path)} | ${finding.sides.join(", ")} | ${markdownCell(finding.detail)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Allowlists", "");
  lines.push(
    markdownList(
      report.staleAllowlist.map(
        (entry) => `Stale \`${entry.fingerprint}\`: ${markdownCell(entry.reason)}`,
      ),
      "No stale allowlist entries.",
    ).trimEnd(),
    "",
  );

  return `${lines.join("\n").trimEnd()}\n`;
}

function audit(options) {
  const repo = gitText(path.resolve(options.repo), ["rev-parse", "--show-toplevel"]).trim();
  const policyInfo = readPolicy(repo, options.policy);
  const { policy } = policyInfo;

  const upstreamCommit = resolveCommit(repo, options.upstream);
  const forkCommit = resolveCommit(repo, options.fork);
  const baseCommit = options.base
    ? resolveCommit(repo, options.base)
    : gitText(repo, ["merge-base", forkCommit, upstreamCommit]).trim();

  if (!baseCommit || !isAncestor(repo, baseCommit, forkCommit) || !isAncestor(repo, baseCommit, upstreamCommit)) {
    throw new Error("The selected base must be an ancestor of both fork and upstream commits");
  }

  const changesBySide = {
    upstream: changedFiles(repo, baseCommit, upstreamCommit),
    fork: changedFiles(repo, baseCommit, forkCommit),
  };
  const conflicts = mergeConflicts(repo, forkCommit, upstreamCommit);
  const overlap = classifyOverlaps(
    repo,
    upstreamCommit,
    forkCommit,
    changesBySide.upstream,
    changesBySide.fork,
    conflicts,
    policy,
  );
  const allRiskChanges = riskChanges(changesBySide, policy);
  const findings = findingCollector();

  const baseCommercialReferences = commercialReferences(repo, baseCommit, policy);
  const commercialReferencesBySide = {
    upstream: commercialReferences(repo, upstreamCommit, policy),
    fork: commercialReferences(repo, forkCommit, policy),
  };
  const addedCommercialReferences = addCommercialFindings(
    baseCommercialReferences,
    commercialReferencesBySide,
    findings,
  );
  addCommercialSourceFindings(changesBySide, policy, findings);
  const generatedArtifacts = generatedArtifactChecks(changesBySide, policy, findings);
  scanForbiddenPaths(changesBySide, policy, findings);
  const domains = scanAddedContent(
    repo,
    baseCommit,
    { upstream: upstreamCommit, fork: forkCommit },
    policy,
    findings,
  );

  const finalizedFindings = findings.finalize(policy.allowlist);
  const staleAllowlist = staleAllowlistEntries(policy, finalizedFindings);
  const effectiveViolations = finalizedFindings.filter(
    (finding) => finding.level === "violation" && !finding.allowed,
  );
  const allowlistedViolations = finalizedFindings.filter(
    (finding) => finding.level === "violation" && finding.allowed,
  );
  const reviewFindings = finalizedFindings.filter((finding) => finding.level === "review");

  const report = {
    schemaVersion: 1,
    outcome: effectiveViolations.length === 0 ? "pass" : "violation",
    refs: {
      base: { requested: options.base || "merge-base", commit: baseCommit },
      upstream: { requested: options.upstream, commit: upstreamCommit },
      fork: { requested: options.fork, commit: forkCommit },
    },
    recordedImplementationBase: policy.metadata,
    policy: {
      path: policyInfo.displayPath,
      sha256: policyInfo.digest,
      schemaVersion: policy.schemaVersion,
    },
    summary: {
      upstreamChangedPaths: changesBySide.upstream.length,
      forkChangedPaths: changesBySide.fork.length,
      overlappingPaths: overlap.length,
      mergeConflicts: conflicts.length,
      highRiskChanges: allRiskChanges.filter((entry) => entry.severity === "high").length,
      policyViolations: effectiveViolations.length,
      allowlistedViolations: allowlistedViolations.length,
      reviewFindings: reviewFindings.length,
    },
    changes: changesBySide,
    conflicts,
    overlap,
    riskChanges: allRiskChanges,
    commercialReachability: {
      baselineReferenceCount: baseCommercialReferences.length,
      upstreamAdded: addedCommercialReferences.upstream,
      forkAdded: addedCommercialReferences.fork,
    },
    generatedArtifacts,
    domains,
    findings: finalizedFindings,
    staleAllowlist,
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = renderMarkdown(report);
  return { report, json, markdown };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const result = audit(options);
    if (options.dryRun) {
      process.stdout.write(result.markdown);
      process.stdout.write("\nDry run: report files were not written.\n");
    } else {
      const repo = gitText(path.resolve(options.repo), ["rev-parse", "--show-toplevel"]).trim();
      const outputDirectory = path.isAbsolute(options.outputDir)
        ? options.outputDir
        : path.join(repo, options.outputDir);
      fs.mkdirSync(outputDirectory, { recursive: true });
      const jsonPath = path.join(outputDirectory, "report.json");
      const markdownPath = path.join(outputDirectory, "report.md");
      fs.writeFileSync(jsonPath, result.json);
      fs.writeFileSync(markdownPath, result.markdown);
      process.stdout.write(
        `Upstream compatibility audit: ${result.report.outcome}. ` +
          `${result.report.summary.policyViolations} policy violation(s), ` +
          `${result.report.summary.mergeConflicts} merge conflict(s).\n` +
          `Reports: ${jsonPath}, ${markdownPath}\n`,
      );
    }
    if (result.report.outcome === "violation") {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`upstream-sync-audit: ${error.message}\n`);
    process.exitCode = 2;
  }
}

main();
