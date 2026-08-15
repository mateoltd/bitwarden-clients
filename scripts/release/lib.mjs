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
  let executable = command;
  let executableArgs = args;
  if ((command === "npm" || command === "npx") && process.env.npm_execpath) {
    executable = process.execPath;
    const cli =
      command === "npm"
        ? process.env.npm_execpath
        : path.join(path.dirname(process.env.npm_execpath), "npx-cli.js");
    executableArgs = [cli, ...args];
  }
  const result = spawnSync(executable, executableArgs, {
    cwd: options.cwd ?? repositoryRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout ?? ""}${result.stderr ?? ""}` : "";
    const cause = result.error
      ? `: ${result.error.message}`
      : result.signal
        ? ` (${result.signal})`
        : "";
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}${cause}${detail}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

export function git(args, options = {}) {
  return run("git", args, { ...options, capture: options.capture ?? true });
}

export function tarText(archive, member) {
  return execFileSync("tar", ["-xOzf", path.basename(archive), member], {
    cwd: path.dirname(archive),
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

/** Parse the SDK producer's legacy text evidence by named keys and value shape, never line order. */
export function parseSdkProducerToolchainEvidence(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const exactlyOne = (pattern, label, value = (match) => match[1]) => {
    const matches = lines.map((line) => pattern.exec(line)).filter(Boolean);
    assert(matches.length === 1, `SDK producer evidence must contain exactly one ${label}`);
    return value(matches[0]);
  };
  return {
    sourceCommit: exactlyOne(/^source_commit=([0-9a-f]{40})$/, "source commit"),
    runnerImage: exactlyOne(/^runner_image=(.+)$/, "runner image"),
    node: exactlyOne(/^v(\d+\.\d+\.\d+)$/, "Node version"),
    npm: exactlyOne(/^(\d+\.\d+\.\d+)$/, "npm version"),
    rust: exactlyOne(/^rustc (\d+\.\d+\.\d+) \(.+\)$/, "Rust version"),
    wasmOpt: exactlyOne(/^wasm-opt version (\d+) \(.+\)$/, "wasm-opt version"),
  };
}

export function targetById(manifest, id) {
  const target = manifest.targets.find((candidate) => candidate.id === id);
  assert(target, `Unknown release target: ${id}`);
  return target;
}
