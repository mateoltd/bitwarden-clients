module.exports = {
  displayName: "ui-redesign-renderer-pilot",
  preset: "../../../jest.preset.js",
  testEnvironment: "jsdom",
  transform: {
    "^.+\\.[tj]sx?$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.json",
        diagnostics: true,
      },
    ],
  },
  testMatch: ["<rootDir>/shared/**/*.spec.ts"],
  moduleFileExtensions: ["ts", "tsx", "js", "html"],
  collectCoverageFrom: ["<rootDir>/shared/**/*.ts"],
  coverageDirectory: "../../../coverage/ui-redesign-renderer-pilot",
};
