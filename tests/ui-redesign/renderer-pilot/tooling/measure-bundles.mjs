import { brotliCompressSync, gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../../../");
const outputRoot = resolve(repositoryRoot, "dist/ui-redesign-renderer-pilot");
const manifest = JSON.parse(await readFile(resolve(outputRoot, "build-manifest.json"), "utf8"));
const measurements = [];

for (const build of manifest) {
  const assets = [];
  for (const asset of build.assets.filter((entry) => /\.(css|js|woff2)$/u.test(entry.name))) {
    const contents = await readFile(resolve(outputRoot, build.renderer, asset.name));
    assets.push({
      name: asset.name,
      rawBytes: contents.byteLength,
      gzipBytes: gzipSync(contents, { level: 9 }).byteLength,
      brotliBytes: brotliCompressSync(contents).byteLength,
    });
  }

  measurements.push({
    renderer: build.renderer,
    assets,
    totals: sumAssets(assets),
    frameworkModules: build.modules.filter((name) =>
      /node_modules\/(?:@angular|lit|react|react-dom)\//u.test(name),
    ),
  });
}

process.stdout.write(`${JSON.stringify(measurements, null, 2)}\n`);

function sumAssets(assets) {
  return assets.reduce(
    (total, asset) => ({
      rawBytes: total.rawBytes + asset.rawBytes,
      gzipBytes: total.gzipBytes + asset.gzipBytes,
      brotliBytes: total.brotliBytes + asset.brotliBytes,
    }),
    { rawBytes: 0, gzipBytes: 0, brotliBytes: 0 },
  );
}
