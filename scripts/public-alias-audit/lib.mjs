import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const root = git(["rev-parse", "--show-toplevel"]).trim();
export const policy = JSON.parse(readFileSync(resolve(scriptDirectory, "policy.json"), "utf8"));

export function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
    stdio: options.stdio,
  });
}

export function resolveCommit(ref) {
  return git(["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function treeEntries(ref) {
  const output = git(["ls-tree", "-r", "-z", "--long", ref], { encoding: "buffer" });
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = record.match(/^(\d+) (\w+) ([0-9a-f]+)\s+(\d+|-)\t([\s\S]+)$/);
      if (!match) {
        throw new Error(`Cannot parse tree record: ${record}`);
      }
      return {
        mode: match[1],
        type: match[2],
        object: match[3],
        size: match[4] === "-" ? null : Number(match[4]),
        path: match[5],
      };
    });
}

export function changedEntries(base, target) {
  const fields = git(["diff", "--name-status", "-z", "--find-renames", base, target], {
    encoding: "buffer",
  })
    .toString("utf8")
    .split("\0");
  const entries = [];
  for (let index = 0; index < fields.length - 1; ) {
    const status = fields[index++];
    if (!status) continue;
    const oldPath = fields[index++];
    if (/^[RC]/.test(status)) {
      entries.push({ status, oldPath, path: fields[index++] });
    } else {
      entries.push({ status, path: oldPath });
    }
  }
  return entries;
}

export function blob(ref, path) {
  return git(["show", `${ref}:${path}`], { encoding: "buffer" });
}

export function objectId(ref, path) {
  const result = spawnSync("git", ["rev-parse", "--verify", `${ref}:${path}`], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function pathMatches(path, patterns) {
  return patterns.some((pattern) => new RegExp(pattern, "i").test(path));
}

export function addedLines(base, target, paths = []) {
  const args = ["diff", "--no-ext-diff", "--no-color", "--unified=0", base, target];
  if (paths.length > 0) args.push("--", ...paths);
  const output = git(args);
  const lines = [];
  let path = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("+++ b/")) {
      path = line.slice(6);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      lines.push({ path, text: line.slice(1) });
    }
  }
  return lines;
}

export function patchId(commit) {
  const shown = spawnSync("git", ["show", "--pretty=format:", "--binary", commit], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (shown.status !== 0) throw new Error(shown.stderr.toString("utf8"));
  const patched = spawnSync("git", ["patch-id", "--stable"], {
    cwd: root,
    input: shown.stdout,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (patched.status !== 0) throw new Error(patched.stderr);
  return patched.stdout.trim().split(/\s+/)[0] || null;
}

export function fail(title, findings) {
  const unique = [...new Set(findings)];
  if (unique.length === 0) return;
  process.stderr.write(`${title}\n${unique.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
}

export function parseRefs(defaultTarget = "HEAD") {
  const [base = policy.baseCommit, target = defaultTarget] = process.argv.slice(2);
  return { base: resolveCommit(base), target: resolveCommit(target) };
}
