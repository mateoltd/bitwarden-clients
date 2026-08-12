import { cp } from "node:fs/promises";

const [mode, fixtureDir, outputDir] = process.argv.slice(2);

if (!mode || !fixtureDir || !outputDir) {
  throw new Error("Usage: fixture-builder.mjs <copy|no-output|fail-after-copy> <fixture> <output>");
}

if (mode !== "no-output") {
  await cp(fixtureDir, outputDir, { recursive: true });
}

if (mode === "fail-after-copy") {
  process.exitCode = 7;
} else if (mode !== "copy" && mode !== "no-output") {
  throw new Error(`Unknown fixture builder mode: ${mode}`);
}
