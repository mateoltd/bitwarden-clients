import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, run } from "./lib.mjs";

const [target, firstArgument, secondArgument] = process.argv.slice(2);
assert(target && firstArgument && secondArgument, "usage: compare-rebuilds.mjs TARGET FIRST SECOND");

const first = path.resolve(firstArgument);
const second = path.resolve(secondArgument);

function digest(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function files(directory) {
  const pending = [directory];
  const result = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) result.push(path.relative(directory, absolute).split(path.sep).join("/"));
    }
  }
  return result.sort();
}

const firstHash = digest(first);
const secondHash = digest(second);
if (firstHash === secondHash) {
  console.log(`${target} reproducible SHA-256 ${firstHash}`);
  process.exit(0);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "alias-rebuild-diff-"));
try {
  const firstDirectory = path.join(temporary, "first");
  const secondDirectory = path.join(temporary, "second");
  const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  run(python, ["scripts/release/archive.py", "--source", first, "--output", firstDirectory, "--extract"]);
  run(python, ["scripts/release/archive.py", "--source", second, "--output", secondDirectory, "--extract"]);
  const names = [...new Set([...files(firstDirectory), ...files(secondDirectory)])].sort();
  const differences = names
    .map((name) => {
      const firstFile = path.join(firstDirectory, name);
      const secondFile = path.join(secondDirectory, name);
      return {
        path: name,
        first: fs.existsSync(firstFile) ? digest(firstFile) : null,
        second: fs.existsSync(secondFile) ? digest(secondFile) : null,
      };
    })
    .filter((entry) => entry.first !== entry.second);
  process.stderr.write(
    `${JSON.stringify({ target, first: firstHash, second: secondHash, differences }, null, 2)}\n`,
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
process.exitCode = 1;
