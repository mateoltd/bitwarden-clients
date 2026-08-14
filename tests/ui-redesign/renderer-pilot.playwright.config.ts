import { defineConfig, devices } from "@playwright/test";

const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: __dirname,
  testMatch: "renderer-pilot/renderer-pilot.spec.ts",
  timeout: 120_000,
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: 2,
  reporter: CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:6010",
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run build:ui-redesign-pilot && node renderer-pilot/tooling/serve.mjs",
      url: "http://127.0.0.1:6010/angular/",
      reuseExistingServer: !CI,
      timeout: 480_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run storybook -- --ci --no-open",
      url: "http://localhost:6006/index.json",
      reuseExistingServer: !CI,
      timeout: 480_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
