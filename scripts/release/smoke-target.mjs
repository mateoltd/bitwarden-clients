import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  assert,
  parseArgs,
  readManifest,
  repositoryRoot,
  requireString,
  run,
  targetById,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const targetId = requireString(args._[0], "release target ID is required");
const artifact = path.resolve(
  repositoryRoot,
  requireString(args._[1], "candidate artifact is required"),
);
const target = targetById(readManifest(), targetId);
assert(fs.existsSync(artifact), `Candidate artifact is missing: ${artifact}`);

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `alias-smoke-${targetId}-`));
const extracted = path.join(temporaryDirectory, "candidate");
run(process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3"), [
  "scripts/release/archive.py",
  "--source",
  artifact,
  "--output",
  extracted,
  "--extract",
]);

function filesBelow(directory) {
  return fs.readdirSync(directory, { recursive: true }).map((entry) => path.join(directory, entry));
}

function executableContaining(fragment) {
  return filesBelow(extracted).find((file) => {
    try {
      return fs.statSync(file).isFile() && path.basename(file).toLowerCase().includes(fragment);
    } catch {
      return false;
    }
  });
}

function waitForLaunch(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: "inherit", ...options });
    let finished = false;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      finished = true;
      reject(new Error(`${command} exited before smoke window (code ${code}, signal ${signal})`));
    });
    setTimeout(() => {
      if (!finished) {
        child.kill(process.platform === "win32" ? undefined : "SIGTERM");
        resolve();
      }
    }, 12_000);
  });
}

async function smokeChromium() {
  const { chromium } = await import("playwright");
  const userDataDir = path.join(temporaryDirectory, "chromium-profile");
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extracted}`,
      `--load-extension=${extracted}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  try {
    let worker = context.serviceWorkers()[0];
    worker ??= await context.waitForEvent("serviceworker", { timeout: 30_000 });
    const extensionId = new URL(worker.url()).host;
    const extensionManifest = JSON.parse(
      fs.readFileSync(path.join(extracted, "manifest.json"), "utf8"),
    );
    const popup =
      extensionManifest.action?.default_popup ?? extensionManifest.browser_action?.default_popup;
    assert(popup, "Extension manifest has no popup to launch");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/${popup}`);
    await page.locator("body").waitFor({ state: "visible" });
  } finally {
    await context.close();
  }
}

async function smokeFirefox() {
  const { firefox } = await import("playwright");
  const webExt = path.join(repositoryRoot, "release/tooling/node_modules/.bin/web-ext");
  assert(fs.existsSync(webExt), "release tooling is not installed");
  run(webExt, ["lint", "--source-dir", extracted]);
  await waitForLaunch(webExt, [
    "run",
    "--source-dir",
    extracted,
    "--firefox",
    firefox.executablePath(),
    "--no-reload",
    "--start-url",
    "about:blank",
  ]);
}

async function smokeSafariProject() {
  const conversion = path.join(temporaryDirectory, "safari-project");
  const derivedData = path.join(temporaryDirectory, "safari-derived-data");
  run("xcrun", [
    "safari-web-extension-converter",
    extracted,
    "--copy-resources",
    "--no-open",
    "--no-prompt",
    "--project-location",
    conversion,
  ]);
  const project = filesBelow(conversion).find((file) => file.endsWith(".xcodeproj"));
  assert(project, "Safari conversion did not produce an Xcode project");
  run("xcodebuild", [
    "-project",
    project,
    "-alltargets",
    "-derivedDataPath",
    derivedData,
    "CODE_SIGNING_ALLOWED=NO",
    "build",
  ]);
  const appExecutable = filesBelow(derivedData).find((file) =>
    /\/Build\/Products\/[^/]+\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/.test(file),
  );
  assert(appExecutable, "Safari conversion did not produce a launchable container app");
  await waitForLaunch(appExecutable, []);
}

async function smokeWeb() {
  const server = http.createServer((request, response) => {
    const requested = request.url === "/" ? "/index.html" : request.url;
    const file = path.resolve(extracted, `.${requested}`);
    if (!file.startsWith(`${path.resolve(extracted)}${path.sep}`) || !fs.existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200).end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert(response.ok, `Web candidate returned HTTP ${response.status}`);
    assert(
      (await response.text()).includes("<html"),
      "Web candidate did not serve an HTML entry point",
    );
  } finally {
    server.close();
  }
}

function smokeCli() {
  const executable =
    target.platform === "win" ? executableContaining("bw.exe") : executableContaining("bw");
  assert(executable, "CLI executable is missing");
  const version = run(executable, ["--version"], { capture: true });
  assert(/^\d{4}\.\d+\.\d+/.test(version), `CLI returned an unexpected version: ${version}`);
}

async function smokeDesktop() {
  let executable;
  let appBundle;
  if (target.platform === "mac") {
    executable = filesBelow(extracted).find((file) =>
      /\.app\/Contents\/MacOS\/Bitwarden$/.test(file),
    );
    appBundle = executable?.slice(0, executable.indexOf(".app/") + 4);
  } else if (target.platform === "win") {
    executable = executableContaining("bitwarden.exe");
  } else {
    executable = filesBelow(extracted).find((file) => path.basename(file) === "bitwarden");
  }
  assert(executable, "Desktop executable is missing");

  if (appBundle) {
    run("codesign", ["--force", "--deep", "--sign", "-", appBundle]);
  }

  if (target.smoke === "package-only") {
    const bytes = fs.readFileSync(executable);
    assert(
      bytes.subarray(0, 2).toString("ascii") === "MZ",
      "Windows candidate is not a PE executable",
    );
    const peOffset = bytes.readUInt32LE(0x3c);
    assert(bytes.readUInt16LE(peOffset + 4) === 0xaa64, "Windows candidate is not ARM64");
    return;
  }

  const environment = { ...process.env, ELECTRON_NO_UPDATER: "1" };
  delete environment.ELECTRON_RUN_AS_NODE;
  await waitForLaunch(
    executable,
    [
      `--user-data-dir=${path.join(temporaryDirectory, "desktop-profile")}`,
      "--no-sandbox",
      "--disable-gpu",
    ],
    { env: environment },
  );
}

try {
  if (target.smoke === "chromium") await smokeChromium();
  else if (target.smoke === "firefox") await smokeFirefox();
  else if (target.smoke === "safari-project") await smokeSafariProject();
  else if (target.smoke === "http") await smokeWeb();
  else if (target.smoke === "cli") smokeCli();
  else await smokeDesktop();
  console.log(`Smoke test passed: ${target.id}`);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
