import { AngularWebpackPlugin } from "@ngtools/webpack";
import HtmlWebpackPlugin from "html-webpack-plugin";
import MiniCssExtractPlugin from "mini-css-extract-plugin";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pilotRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(pilotRoot, "../../..");
const outputRoot = resolve(repositoryRoot, "dist/ui-redesign-renderer-pilot");
const htmlTemplate = resolve(pilotRoot, "harness/index.html");

function createBaseConfig(name, entry) {
  return {
    name,
    mode: "production",
    context: repositoryRoot,
    entry: resolve(pilotRoot, entry),
    devtool: false,
    output: {
      path: resolve(outputRoot, name),
      filename: "pilot.js",
      assetModuleFilename: "assets/[name][ext]",
      clean: true,
    },
    resolve: {
      extensions: [".tsx", ".ts", ".js"],
    },
    module: {
      rules: [
        {
          test: /\.css$/u,
          use: [MiniCssExtractPlugin.loader, "css-loader"],
        },
        {
          test: /\.woff2?$/u,
          type: "asset/resource",
        },
      ],
    },
    optimization: {
      minimize: true,
      runtimeChunk: false,
      splitChunks: false,
      usedExports: true,
    },
    performance: false,
    plugins: [
      new MiniCssExtractPlugin({ filename: "pilot.css" }),
      new HtmlWebpackPlugin({
        filename: "index.html",
        hash: true,
        inject: "body",
        scriptLoading: "defer",
        template: htmlTemplate,
      }),
    ],
    stats: "errors-warnings",
  };
}

const angular = createBaseConfig("angular", "angular/bootstrap.ts");
angular.module.rules.unshift({
  test: /\.[cm]?js$/u,
  exclude: /\.wasm\.js$/u,
  loader: "babel-loader",
  options: {
    configFile: resolve(repositoryRoot, "babel.config.json"),
    compact: true,
  },
});
angular.module.rules.unshift({
  test: /\.[jt]sx?$/u,
  loader: "@ngtools/webpack",
  exclude: /node_modules/u,
});
angular.plugins.push(
  new AngularWebpackPlugin({
    tsconfig: resolve(pilotRoot, "tsconfig.angular.json"),
    jitMode: false,
  }),
);

function createTypescriptConfig(name, entry) {
  const config = createBaseConfig(name, entry);
  config.module.rules.unshift({
    test: /\.tsx?$/u,
    loader: "ts-loader",
    exclude: /node_modules/u,
    options: {
      configFile: resolve(pilotRoot, "tsconfig.build.json"),
      onlyCompileBundledFiles: true,
      transpileOnly: false,
    },
  });
  return config;
}

export const rendererPilotWebpackConfigs = [
  angular,
  createTypescriptConfig("react", "react/bootstrap.tsx"),
  createTypescriptConfig("lit", "lit/bootstrap.ts"),
];
