import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../../../");
const exactBase = "346b7658564b5d631b093e80b155b07564dc85c6";
const pilotRoot = resolve(repositoryRoot, "tests/ui-redesign/renderer-pilot");
const failures = [];

await checkFrameworkNeutralSharedPort();
await checkTokenSource();
await checkDependencyPlacement();
await checkProductionSourceGraph();
await checkPilotCspArtifacts();
await checkProductionArtifacts(process.argv.slice(2));

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Renderer pilot dependency and artifact boundaries passed.\n");
}

async function checkFrameworkNeutralSharedPort() {
  const files = await listFiles(resolve(pilotRoot, "shared"));
  const forbidden =
    /(?:from\s+["'](?:@angular|react|react-dom|lit|electron)|\bchrome\.|\bbrowser\.)/u;
  for (const file of files.filter((entry) => extname(entry) === ".ts")) {
    const source = await readFile(file, "utf8");
    if (forbidden.test(source)) {
      failures.push(`Framework or platform type crossed the shared port: ${relative(file)}`);
    }
  }
}

async function checkTokenSource() {
  const previousTheme = execFileSync(
    "git",
    ["show", exactBase + ":libs/components/src/tw-theme.css"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const semanticTokens = await readFile(
    resolve(repositoryRoot, "libs/components/src/semantic-tokens.css"),
    "utf8",
  );
  const currentTheme = await readFile(
    resolve(repositoryRoot, "libs/components/src/tw-theme.css"),
    "utf8",
  );
  const previousDeclarations = declarationBlock(previousTheme);
  const currentDeclarations = semanticTokens.slice(semanticTokens.indexOf(":root")).trim();

  if (previousDeclarations !== currentDeclarations) {
    failures.push("The semantic-token extraction changed token declarations from the exact base.");
  }
  if (currentTheme.includes(":root {") || currentTheme.includes(".theme_dark {")) {
    failures.push("tw-theme.css still duplicates semantic token declarations.");
  }
}

async function checkDependencyPlacement() {
  const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
  for (const dependency of ["react", "react-dom"]) {
    if (packageJson.dependencies?.[dependency] !== undefined) {
      failures.push(`${dependency} must not be a production dependency.`);
    }
    if (packageJson.devDependencies?.[dependency] === undefined) {
      failures.push(`${dependency} must be explicit test-harness infrastructure.`);
    }
  }
}

async function checkProductionSourceGraph() {
  const productionRoots = ["apps/web", "apps/browser", "apps/desktop"];
  const patterns = [
    "tests/ui-redesign/renderer-pilot",
    'from "react"',
    "from 'react'",
    'from "react-dom',
    "from 'react-dom",
  ];

  for (const root of productionRoots) {
    for (const pattern of patterns) {
      const matches = gitGrep(pattern, root);
      if (matches.length > 0) {
        failures.push(`Production source imports pilot-only code: ${matches.join(", ")}`);
      }
    }
  }
}

async function checkPilotCspArtifacts() {
  const outputRoot = resolve(repositoryRoot, "dist/ui-redesign-renderer-pilot");
  for (const renderer of ["angular", "react", "lit"]) {
    const script = await readFile(resolve(outputRoot, renderer, "pilot.js"), "utf8");
    for (const pattern of [/\beval\s*\(/u, /\bnew\s+Function\b/u, /import\s*\(\s*["']https?:/u]) {
      if (pattern.test(script)) {
        failures.push(`${renderer} pilot bundle violates the packaged-code CSP check: ${pattern}`);
      }
    }
  }
}

async function checkProductionArtifacts(paths) {
  const forbiddenSignatures = [
    "renderer-pilot",
    "ui-redesign-react-renderer-pilot",
    "Minified React error",
    "__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED",
  ];

  for (const providedPath of paths) {
    const artifactRoot = resolve(repositoryRoot, providedPath);
    if (!existsSync(artifactRoot)) {
      failures.push(`Production artifact path does not exist: ${providedPath}`);
      continue;
    }
    for (const file of await listFiles(artifactRoot)) {
      if (!/\.(?:css|html|js|json|mjs)$/u.test(file)) {
        continue;
      }
      const contents = await readFile(file, "utf8");
      const signature = forbiddenSignatures.find((candidate) => contents.includes(candidate));
      if (signature !== undefined) {
        failures.push(
          `Pilot or React runtime signature ${JSON.stringify(signature)} leaked into production artifact: ${relative(file)}`,
        );
      }
    }
  }
}

function declarationBlock(source) {
  const start = source.indexOf(":root {");
  const end = source.indexOf("/* Render browser-drawn form control UI");
  if (start < 0 || end < 0) {
    throw new Error("Unable to locate the exact-base semantic token block.");
  }
  return source.slice(start, end).trim();
}

function gitGrep(pattern, root) {
  try {
    return execFileSync("git", ["grep", "-l", "-F", pattern, "--", root], {
      cwd: repositoryRoot,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    if (error.status === 1) {
      return [];
    }
    throw error;
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    }),
  );
  return nested.flat();
}

function relative(path) {
  return path.slice(repositoryRoot.length + 1);
}
