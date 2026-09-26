const { pathsToModuleNameMapper } = require("ts-jest");
const { createCjsPreset } = require("jest-preset-angular/presets");

const { compilerOptions } = require("../../../../tsconfig.base");
const sharedConfig = require("../../../shared/jest.config.angular");

/** @type {import('jest').Config} */
module.exports = {
  ...sharedConfig,
  ...createCjsPreset({
    tsconfig: "<rootDir>/tsconfig.spec.json",
    astTransformers: {
      before: ["<rootDir>/../../../shared/es2020-transformer.ts"],
    },
    diagnostics: { ignoreCodes: ["TS151001"] },
  }),
  setupFilesAfterEnv: ["<rootDir>/test.setup.ts"],
  moduleNameMapper: pathsToModuleNameMapper(
    { "@bitwarden/common/spec": ["libs/common/spec"], ...(compilerOptions?.paths ?? {}) },
    { prefix: "<rootDir>/../../../../" },
  ),
};
