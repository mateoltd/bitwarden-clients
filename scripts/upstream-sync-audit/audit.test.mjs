import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.join(HERE, "audit.mjs");
const FIXTURE_POLICY = path.join(HERE, "fixtures", "policy.json");
const temporaryDirectories = [];

test.afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRepository() {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-sync-audit-"));
  temporaryDirectories.push(repository);
  git(repository, "init", "--initial-branch=main", "--quiet");
  git(repository, "config", "user.name", "Audit Fixture");
  git(repository, "config", "user.email", "audit-fixture@example.com");
  return repository;
}

function git(repository, ...args) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function write(repository, filePath, contents) {
  const absolutePath = path.join(repository, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
}

function commit(repository, message) {
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "--message", message);
  return git(repository, "rev-parse", "HEAD");
}

function baseHistory(extraFiles = {}) {
  const repository = temporaryRepository();
  const files = {
    "apps/web/app.ts": "export const app = 'base';\n",
    "bitwarden_license/secret.ts": "export const secret = 'base';\n",
    "schema/model.txt": "version=1\n",
    "generated/model.ts": "export const version = 1;\n",
    ...extraFiles,
  };
  for (const [filePath, contents] of Object.entries(files)) {
    write(repository, filePath, contents);
  }
  const base = commit(repository, "base");
  git(repository, "branch", "fork", base);
  git(repository, "branch", "upstream", base);
  return { repository, base };
}

function onBranch(repository, branch, changes, message) {
  git(repository, "switch", "--quiet", branch);
  for (const [filePath, contents] of Object.entries(changes)) {
    write(repository, filePath, contents);
  }
  return commit(repository, message);
}

function runAudit(repository, options = {}) {
  const outputDirectory = options.outputDirectory || path.join(repository, "reports");
  const policy = options.policy || FIXTURE_POLICY;
  const args = [
    AUDIT,
    "--repo",
    repository,
    "--policy",
    policy,
    "--upstream",
    "upstream",
    "--fork",
    "fork",
    "--output-dir",
    outputDirectory,
  ];
  if (options.dryRun) args.push("--dry-run");
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  return { ...result, outputDirectory };
}

function readReport(outputDirectory) {
  return JSON.parse(fs.readFileSync(path.join(outputDirectory, "report.json"), "utf8"));
}

test("produces deterministic reports and classifies security-sensitive changes", () => {
  const { repository } = baseHistory();
  onBranch(
    repository,
    "fork",
    { "apps/web/fork-feature.ts": "export const forkFeature = true;\n" },
    "fork change",
  );
  onBranch(
    repository,
    "upstream",
    { "apps/browser/autofill-settings.ts": "export const autofill = true;\n" },
    "upstream change",
  );

  const first = runAudit(repository);
  assert.equal(first.status, 0, first.stderr);
  const firstJson = fs.readFileSync(path.join(first.outputDirectory, "report.json"), "utf8");
  const report = JSON.parse(firstJson);
  assert.equal(report.outcome, "pass");
  assert.deepEqual(
    report.riskChanges
      .filter((entry) => entry.path === "apps/browser/autofill-settings.ts")
      .map((entry) => entry.surface),
    ["autofill", "extension"],
  );

  const secondDirectory = path.join(repository, "reports-second");
  const second = runAudit(repository, { outputDirectory: secondDirectory });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(path.join(secondDirectory, "report.json"), "utf8"), firstJson);

  const dryRunDirectory = path.join(repository, "dry-run-must-not-exist");
  const dryRun = runAudit(repository, { outputDirectory: dryRunDirectory, dryRun: true });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /# Upstream compatibility audit/);
  assert.equal(fs.existsSync(dryRunDirectory), false);
});

test("reports real merge conflicts without treating them as policy violations", () => {
  const { repository } = baseHistory({ "shared.txt": "base\n" });
  onBranch(repository, "fork", { "shared.txt": "fork\n" }, "fork conflict");
  onBranch(repository, "upstream", { "shared.txt": "upstream\n" }, "upstream conflict");

  const result = runAudit(repository);
  assert.equal(result.status, 0, result.stderr);
  const report = readReport(result.outputDirectory);
  assert.equal(report.outcome, "pass");
  assert.deepEqual(report.conflicts, ["shared.txt"]);
  assert.deepEqual(report.overlap, [
    { path: "shared.txt", classification: "merge-conflict", riskSurfaces: [] },
  ]);
});

test("distinguishes identical changes from non-conflicting overlaps", () => {
  const { repository } = baseHistory({ "shared-lines.txt": "first\nsecond\nthird\n" });
  onBranch(
    repository,
    "fork",
    {
      "same.txt": "same content\n",
      "shared-lines.txt": "fork first\nsecond\nthird\n",
    },
    "fork overlaps",
  );
  onBranch(
    repository,
    "upstream",
    {
      "same.txt": "same content\n",
      "shared-lines.txt": "first\nsecond\nupstream third\n",
    },
    "upstream overlaps",
  );

  const result = runAudit(repository);
  assert.equal(result.status, 0, result.stderr);
  const classifications = new Map(
    readReport(result.outputDirectory).overlap.map((entry) => [entry.path, entry.classification]),
  );
  assert.equal(classifications.get("same.txt"), "identical-change");
  assert.equal(classifications.get("shared-lines.txt"), "clean-overlap");
});

test("fails only for explicit boundary, generated, commercial, and personal-code policies", () => {
  const { repository } = baseHistory();
  onBranch(
    repository,
    "fork",
    {
      "apps/web/commercial-edge.ts":
        'import { secret } from "@bitwarden/bit-common/secret";\nexport { secret };\n',
      "bitwarden_license/secret.ts": "export const secret = 'fork changed';\n",
      "personal-migration/config.ts":
        'export const home = "/Users/alice/project";\nexport const url = "https://vault.team.internal/";\n',
      "schema/model.txt": "version=2\n",
    },
    "policy violations",
  );

  const result = runAudit(repository);
  assert.equal(result.status, 1, result.stderr);
  const report = readReport(result.outputDirectory);
  assert.equal(report.outcome, "violation");
  const rules = new Set(report.findings.filter((finding) => !finding.allowed).map((finding) => finding.ruleId));
  assert.ok(rules.has("unexpected-commercial-reachability"));
  assert.ok(rules.has("fork-commercial-source-change"));
  assert.ok(rules.has("generated-source-without-artifact"));
  assert.ok(rules.has("forbidden-path:personal-migration-path"));
  assert.ok(rules.has("forbidden-content:personal-home"));
  assert.ok(rules.has("forbidden-domain:private-domain"));

  const policy = JSON.parse(fs.readFileSync(FIXTURE_POLICY, "utf8"));
  policy.allowlist = report.findings
    .filter((finding) => finding.level === "violation")
    .map((finding) => ({ fingerprint: finding.fingerprint, reason: "Synthetic fixture approval" }));
  const allowlistedPolicy = path.join(repository, "allowlisted-policy.json");
  fs.writeFileSync(allowlistedPolicy, `${JSON.stringify(policy, null, 2)}\n`);

  const allowedDirectory = path.join(repository, "reports-allowed");
  const allowed = runAudit(repository, { policy: allowlistedPolicy, outputDirectory: allowedDirectory });
  assert.equal(allowed.status, 0, allowed.stderr);
  const allowedReport = readReport(allowedDirectory);
  assert.equal(allowedReport.outcome, "pass");
  assert.equal(allowedReport.summary.policyViolations, 0);
  assert.ok(allowedReport.findings.filter((finding) => finding.level === "violation").every((finding) => finding.allowed));
});
