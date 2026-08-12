import { readFile, readdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "..");
const FRESHNESS_TOLERANCE_MS = 1_000;

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

export const storybooks = {
  components: {
    builder: "webpack",
    command: npmCommand,
    args: ["run", "build-storybook", "--", "--webpack-stats-json"],
    cwd: REPOSITORY_ROOT,
    outputDir: join(REPOSITORY_ROOT, "storybook-static"),
  },
  autofill: {
    builder: "vite",
    command: npmCommand,
    args: ["run", "storybook:build-lit:ci"],
    cwd: join(REPOSITORY_ROOT, "apps/browser/src/autofill/content/components"),
    outputDir: join(
      REPOSITORY_ROOT,
      "apps/browser/src/autofill/content/components/storybook-static",
    ),
  },
};

function assertBuilder(builder) {
  if (builder !== "vite" && builder !== "webpack") {
    throw new Error(`Unsupported Storybook builder: ${builder}`);
  }
}

async function readArtifact(outputDir, artifact, buildStartedAt) {
  const artifactPath = join(outputDir, artifact);
  let artifactStat;

  try {
    artifactStat = await stat(artifactPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Storybook output is missing ${artifact}`);
    }

    throw error;
  }

  if (!artifactStat.isFile() || artifactStat.size === 0) {
    throw new Error(`Storybook output has an empty or invalid ${artifact}`);
  }

  if (
    buildStartedAt !== undefined &&
    artifactStat.mtimeMs + FRESHNESS_TOLERANCE_MS < buildStartedAt
  ) {
    throw new Error(`Storybook output contains stale ${artifact}`);
  }

  return readFile(artifactPath, "utf8");
}

function parseJsonArtifact(contents, artifact) {
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`Storybook output has invalid JSON in ${artifact}`);
  }
}

async function validateVitePreviewBundle(outputDir, buildStartedAt) {
  const assetsDir = join(outputDir, "assets");
  let assets;

  try {
    assets = await readdir(assetsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Vite Storybook output is missing its assets directory");
    }

    throw error;
  }

  const previewBundle = assets.find(
    (asset) => asset.isFile() && /^iframe(?:-[^/]+)?\.js$/.test(asset.name),
  );
  if (!previewBundle) {
    throw new Error("Vite Storybook output is missing its preview bundle");
  }

  await readArtifact(outputDir, join("assets", previewBundle.name), buildStartedAt);
}

export async function validateStorybookOutput({ builder, outputDir, buildStartedAt }) {
  assertBuilder(builder);

  const indexHtml = await readArtifact(outputDir, "index.html", buildStartedAt);
  const iframeHtml = await readArtifact(outputDir, "iframe.html", buildStartedAt);
  const indexJsonContents = await readArtifact(outputDir, "index.json", buildStartedAt);

  if (!/<html(?:\s|>)/i.test(indexHtml)) {
    throw new Error("Storybook output has an invalid index.html");
  }

  if (!/<html(?:\s|>)/i.test(iframeHtml)) {
    throw new Error("Storybook output has an invalid iframe.html");
  }

  const indexJson = parseJsonArtifact(indexJsonContents, "index.json");
  if (
    typeof indexJson !== "object" ||
    indexJson === null ||
    typeof indexJson.entries !== "object" ||
    indexJson.entries === null ||
    Object.keys(indexJson.entries).length === 0
  ) {
    throw new Error("Storybook output has no indexed stories");
  }

  let moduleCount;
  if (builder === "vite") {
    await validateVitePreviewBundle(outputDir, buildStartedAt);
  } else {
    const statsJsonContents = await readArtifact(outputDir, "preview-stats.json", buildStartedAt);
    const statsJson = parseJsonArtifact(statsJsonContents, "preview-stats.json");
    if (
      typeof statsJson !== "object" ||
      statsJson === null ||
      !Array.isArray(statsJson.modules) ||
      statsJson.modules.length === 0 ||
      !statsJson.modules.some(
        (module) => typeof module?.name === "string" && module.name.length > 0,
      ) ||
      !Array.isArray(statsJson.assets) ||
      statsJson.assets.length === 0
    ) {
      throw new Error("Webpack Storybook output has no usable dependency or asset stats");
    }
    moduleCount = statsJson.modules.length;
  }

  return {
    builder,
    outputDir: resolve(outputDir),
    storyCount: Object.keys(indexJson.entries).length,
    moduleCount,
  };
}

function assertSafeOutputDirectory(outputDir) {
  const resolvedOutputDir = resolve(outputDir);
  const { root } = parse(resolvedOutputDir);

  if (
    resolvedOutputDir === root ||
    resolvedOutputDir === REPOSITORY_ROOT ||
    basename(resolvedOutputDir) !== "storybook-static"
  ) {
    throw new Error(`Refusing to clean unsafe Storybook output directory: ${resolvedOutputDir}`);
  }
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

async function runProcess({ command, args, cwd, stdio }) {
  await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio,
    });

    child.once("error", rejectProcess);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveProcess();
        return;
      }

      const result = signal ? `signal ${signal}` : `status ${code}`;
      rejectProcess(new Error(`Storybook build command failed with ${result}`));
    });
  });
}

export async function runStorybookBuild({
  builder,
  command,
  args = [],
  cwd = process.cwd(),
  outputDir,
  stdio = "inherit",
}) {
  assertBuilder(builder);
  assertSafeOutputDirectory(outputDir);

  await rm(outputDir, { recursive: true, force: true });
  const buildStartedAt = Date.now();

  try {
    await runProcess({ command, args, cwd, stdio });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${formatCommand(command, args)} failed: ${message}`, { cause: error });
  }

  return validateStorybookOutput({ builder, outputDir, buildStartedAt });
}

async function main(argv) {
  if (argv[0] === "--validate") {
    const [, builder, outputDir] = argv;
    if (!builder || !outputDir || argv.length !== 3) {
      throw new Error("Usage: storybook-ci.mjs --validate <vite|webpack> <output-directory>");
    }

    const result = await validateStorybookOutput({ builder, outputDir });
    console.log(`Validated ${result.builder} Storybook output with ${result.storyCount} stories`);
    return;
  }

  const [storybookName] = argv;
  const storybook = storybooks[storybookName];

  if (!storybook || argv.length !== 1) {
    throw new Error(`Usage: storybook-ci.mjs <${Object.keys(storybooks).join("|")}>`);
  }

  console.log(`Building ${storybookName} Storybook with ${storybook.builder}`);
  const result = await runStorybookBuild(storybook);
  const outputPath = relative(REPOSITORY_ROOT, result.outputDir);
  console.log(`Validated ${result.storyCount} stories in ${outputPath}`);
}

const isDirectInvocation =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectInvocation) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Storybook CI failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
