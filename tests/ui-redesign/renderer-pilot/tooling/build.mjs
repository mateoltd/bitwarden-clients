import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import webpack from "webpack";

import { rendererPilotWebpackConfigs } from "./webpack.config.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../../../");
const outputRoot = resolve(repositoryRoot, "dist/ui-redesign-renderer-pilot");
const stats = await runWebpack();
const manifest = stats.stats.map((rendererStats) => {
  const data = rendererStats.toJson({
    all: false,
    assets: true,
    modules: true,
    nestedModules: true,
  });
  return {
    renderer: rendererStats.compilation.name,
    assets: (data.assets ?? []).map((asset) => ({ name: asset.name, bytes: asset.size })),
    modules: flattenModules(data.modules ?? [])
      .map((module) => module.name)
      .filter(Boolean),
  };
});

await mkdir(outputRoot, { recursive: true });
await writeFile(
  resolve(outputRoot, "build-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`Built renderer pilot bundles in ${outputRoot}\n`);

function runWebpack() {
  return new Promise((resolveBuild, rejectBuild) => {
    const compiler = webpack(rendererPilotWebpackConfigs);
    compiler.run((error, buildStats) => {
      compiler.close(() => undefined);
      if (error) {
        rejectBuild(error);
        return;
      }
      if (!buildStats || buildStats.hasErrors()) {
        rejectBuild(new Error(buildStats?.toString("errors-warnings") ?? "Webpack failed."));
        return;
      }
      resolveBuild(buildStats);
    });
  });
}

function flattenModules(modules) {
  return modules.flatMap((module) => [module, ...flattenModules(module.modules ?? [])]);
}
