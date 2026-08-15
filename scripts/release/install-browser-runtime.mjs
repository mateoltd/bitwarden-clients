import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  assert,
  parseArgs,
  readJson,
  readManifest,
  repositoryRoot,
  requireString,
  run,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const outputArgument = requireString(args.output, "--output is required");
assert(path.isAbsolute(outputArgument), "Chromium runtime output must be absolute");
const outputDirectory = path.resolve(outputArgument);
assert(
  process.platform === "linux" && process.arch === "x64",
  "Chromium runtime requires Linux x64",
);
assert(path.basename(outputDirectory) === "playwright-chromium", "Unexpected Chromium output path");
assert(!fs.existsSync(outputDirectory), `Chromium output already exists: ${outputDirectory}`);

const manifest = readManifest();
const runtime = manifest.testInfrastructure.chromium;
const playwrightBrowsers = readJson(
  path.join(repositoryRoot, "node_modules/playwright-core/browsers.json"),
);
const chromium = playwrightBrowsers.browsers.find(({ name }) => name === "chromium");
assert(chromium?.revision === runtime.revision, "Playwright Chromium revision differs from pin");
assert(
  chromium?.browserVersion === runtime.version,
  "Playwright Chromium version differs from pin",
);
assert(
  runtime.playwrightVersion === manifest.toolchains.playwright,
  "Playwright runtime pin differs",
);

const downloadUrl = new URL(runtime.url);
assert(downloadUrl.protocol === "https:", "Chromium runtime URL must use HTTPS");
assert(downloadUrl.hostname === "cdn.playwright.dev", "Chromium runtime host is not pinned");
assert(/^[0-9a-f]{64}$/.test(runtime.sha256), "Chromium runtime SHA-256 is invalid");
assert(
  Number.isSafeInteger(runtime.bytes) && runtime.bytes > 0,
  "Chromium runtime size is invalid",
);

fs.mkdirSync(outputDirectory);
const archive = path.join(outputDirectory, "chromium.zip.part");
try {
  const response = await fetch(downloadUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  assert(response.ok && response.body, `Chromium download failed with HTTP ${response.status}`);

  const digest = createHash("sha256");
  let bytes = 0;
  const descriptor = fs.openSync(archive, "wx", 0o600);
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      fs.writeSync(descriptor, buffer);
      digest.update(buffer);
      bytes += buffer.length;
    }
  } finally {
    fs.closeSync(descriptor);
  }

  assert(bytes === runtime.bytes, `Chromium runtime size differs: ${bytes}`);
  assert(digest.digest("hex") === runtime.sha256, "Chromium runtime SHA-256 differs");
  const members = run("unzip", ["-Z1", archive], { capture: true }).split("\n").filter(Boolean);
  assert(members.length > 0, "Chromium runtime archive is empty");
  assert(
    members.every(
      (member) => member.startsWith("chrome-linux64/") && !member.split("/").includes(".."),
    ),
    "Chromium runtime archive contains an unexpected member",
  );
  run("unzip", ["-q", archive, "-d", outputDirectory]);
  fs.unlinkSync(archive);

  const executable = path.join(outputDirectory, "chrome-linux64/chrome");
  assert(fs.existsSync(executable), "Chromium runtime executable is missing");
  fs.chmodSync(executable, 0o755);
  const version = run(executable, ["--version"], { capture: true });
  assert(version.includes(runtime.version), `Unexpected Chromium runtime version: ${version}`);
  console.error(
    `Verified Playwright Chromium ${runtime.version} (${runtime.sha256}, ${runtime.bytes} bytes)`,
  );
  console.log(executable);
} catch (error) {
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  throw error;
}
