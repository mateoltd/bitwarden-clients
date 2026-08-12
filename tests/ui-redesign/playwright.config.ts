import { defineConfig, devices } from "@playwright/test";

const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: __dirname,
  testMatch: "*.spec.ts",
  timeout: 120_000,
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: 2,
  reporter: CI ? [["line"], ["html", { open: "never" }]] : "list",
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:6006",
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  webServer: [
    {
      command: "npm run storybook -- --ci --no-open",
      url: "http://localhost:6006/index.json",
      reuseExistingServer: !CI,
      timeout: 480_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run storybook:autofill:combined -- --ci",
      url: "http://localhost:6007/index.json",
      reuseExistingServer: !CI,
      timeout: 480_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
