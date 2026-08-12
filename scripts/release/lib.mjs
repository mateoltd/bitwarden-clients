import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const manifestPath = path.join(repositoryRoot, "release/alias-client-release.json");

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readManifest() {
  return readJson(manifestPath);
}

export function hashFile(file, algorithm = "sha256", encoding = "hex") {
  return createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
}

export function sha512Integrity(file) {
  return `sha512-${hashFile(file, "sha512", "base64")}`;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout ?? ""}${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}${detail}`);
  }
  return result.stdout?.trim() ?? "";
}

export function git(args, options = {}) {
  return run("git", args, { ...options, capture: options.capture ?? true });
}

export function tarText(archive, member) {
  return execFileSync("tar", ["-xOzf", archive, member], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

export function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      parsed[name] = true;
    } else {
      parsed[name] = next;
      index += 1;
    }
  }
  return parsed;
}

export function requireString(value, message) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function targetById(manifest, id) {
  const target = manifest.targets.find((candidate) => candidate.id === id);
  assert(target, `Unknown release target: ${id}`);
  return target;
}
