import assert from "node:assert/strict";
import { cp, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runStorybookBuild, validateStorybookOutput } from "./storybook-ci.mjs";

const fixturesDir = join(import.meta.dirname, "storybook-ci.fixtures");
const fixtureBuilder = join(fixturesDir, "fixture-builder.mjs");

async function temporaryOutput(t) {
  const directory = await mkdtemp(join(tmpdir(), "storybook-ci-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "storybook-static");
}

function fixtureBuild({ builder, fixture, outputDir, mode = "copy" }) {
  return runStorybookBuild({
    builder,
    command: process.execPath,
    args: [fixtureBuilder, mode, join(fixturesDir, fixture), outputDir],
    outputDir,
    stdio: "ignore",
  });
}

test("accepts complete Vite Storybook output without preview-stats.json", async (t) => {
  const outputDir = await temporaryOutput(t);

  const result = await fixtureBuild({
    builder: "vite",
    fixture: "valid-vite",
    outputDir,
  });

  assert.equal(result.storyCount, 1);
  assert.equal(result.moduleCount, undefined);
});

test("accepts complete Webpack Storybook output with bundled asset stats", async (t) => {
  const outputDir = await temporaryOutput(t);

  const result = await fixtureBuild({
    builder: "webpack",
    fixture: "valid-webpack",
    outputDir,
  });

  assert.equal(result.storyCount, 1);
  assert.equal(result.moduleCount, 1);
});

test("rejects a successful process that produces no Storybook output", async (t) => {
  const outputDir = await temporaryOutput(t);

  await assert.rejects(
    fixtureBuild({
      builder: "vite",
      fixture: "valid-vite",
      outputDir,
      mode: "no-output",
    }),
    /missing index\.html/,
  );
});

test("rejects partial Storybook output", async (t) => {
  const outputDir = await temporaryOutput(t);

  await assert.rejects(
    fixtureBuild({
      builder: "vite",
      fixture: "partial",
      outputDir,
    }),
    /missing its assets directory/,
  );
});

test("rejects complete but stale Storybook output", async (t) => {
  const outputDir = await temporaryOutput(t);
  await cp(join(fixturesDir, "valid-vite"), outputDir, { recursive: true });

  const staleDate = new Date(Date.now() - 60_000);
  await Promise.all(
    ["index.html", "iframe.html", "index.json", "assets/iframe-fixture.js"].map((artifact) =>
      utimes(join(outputDir, artifact), staleDate, staleDate),
    ),
  );

  await assert.rejects(
    validateStorybookOutput({
      builder: "vite",
      outputDir,
      buildStartedAt: Date.now(),
    }),
    /stale/,
  );
});

test("rejects a failed build process even when it writes complete output", async (t) => {
  const outputDir = await temporaryOutput(t);

  await assert.rejects(
    fixtureBuild({
      builder: "vite",
      fixture: "valid-vite",
      outputDir,
      mode: "fail-after-copy",
    }),
    /status 7/,
  );
});

test("rejects Webpack output without preview-stats.json", async (t) => {
  const outputDir = await temporaryOutput(t);

  await assert.rejects(
    fixtureBuild({
      builder: "webpack",
      fixture: "valid-vite",
      outputDir,
    }),
    /missing preview-stats\.json/,
  );
});
