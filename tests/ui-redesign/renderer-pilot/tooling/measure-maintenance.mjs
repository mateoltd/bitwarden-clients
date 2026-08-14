import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../../../");
const pilotRoot = resolve(repositoryRoot, "tests/ui-redesign/renderer-pilot");
const categories = {
  sharedContractAndFixtures: [
    "shared/contracts.ts",
    "shared/controller.ts",
    "shared/fixtures.ts",
    "shared/index.ts",
    "shared/localization.ts",
    "shared/semantic-tokens.ts",
    "shared/state.ts",
  ],
  angularAdapter: [
    "angular/angular-renderer-pilot.component.ts",
    "angular/mount.ts",
    "angular/bootstrap.ts",
  ],
  reactAdapter: ["react/react-renderer-pilot.tsx", "react/mount.tsx", "react/bootstrap.tsx"],
  litAdapter: ["lit/lit-renderer-pilot.element.ts", "lit/mount.ts", "lit/bootstrap.ts"],
  tests: ["shared/controller.spec.ts", "renderer-pilot.spec.ts"],
  harnessAndTooling: [
    "harness/page.ts",
    "storybook/story-hosts.ts",
    "storybook/renderer-pilot.stories.ts",
    "tooling/build.mjs",
    "tooling/check-boundaries.mjs",
    "tooling/measure-bundles.mjs",
    "tooling/measure-runtime.mjs",
    "tooling/serve.mjs",
    "tooling/webpack.config.mjs",
  ],
};
const measurements = {};

for (const [category, paths] of Object.entries(categories)) {
  const files = await Promise.all(
    paths.map(async (path) => ({
      path,
      lines: countLines(await readFile(resolve(pilotRoot, path), "utf8")),
    })),
  );
  measurements[category] = {
    fileCount: files.length,
    nonBlankLines: files.reduce((total, file) => total + file.lines, 0),
    files,
  };
}

const upstreamLog = git([
  "log",
  "-250",
  "--format=commit:%H",
  "--name-only",
  "upstream/main",
  "--",
  "libs/components/src/no-items",
]);
const upstreamCommits = upstreamLog.split("\n").filter((line) => line.startsWith("commit:")).length;
const upstreamFiles = new Set(
  upstreamLog.split("\n").filter((line) => line.startsWith("libs/components/src/no-items/")),
);
const existingFileDiff = git([
  "diff",
  "--numstat",
  "346b7658564b5d631b093e80b155b07564dc85c6",
  "--",
  ".storybook/main.ts",
  "libs/components/src/tw-theme.css",
  "libs/components/tsconfig.app.json",
  "package.json",
  "package-lock.json",
]);

process.stdout.write(
  `${JSON.stringify(
    {
      measurements,
      upstreamMaintenanceSample: {
        range: "latest 250 commits at upstream/main",
        selectedLeafCommitsTouched: upstreamCommits,
        selectedLeafFilesTouched: [...upstreamFiles].sort(),
      },
      existingFileDiff: existingFileDiff.split("\n").filter(Boolean),
    },
    null,
    2,
  )}\n`,
);

function countLines(source) {
  return source.split("\n").filter((line) => line.trim().length > 0).length;
}

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}
