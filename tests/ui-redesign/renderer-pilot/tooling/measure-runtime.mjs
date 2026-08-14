import { chromium } from "@playwright/test";

const renderers = ["angular", "react", "lit"];
const conditions = [
  { name: "web", viewport: { width: 1440, height: 900 } },
  { name: "browserPopup", viewport: { width: 390, height: 600 } },
  { name: "desktopRenderer", viewport: { width: 1280, height: 800 } },
];
const runs = 15;
const baseUrl = process.env.RENDERER_PILOT_URL ?? "http://127.0.0.1:6010";
const browser = await chromium.launch();
const measurements = [];

for (const renderer of renderers) {
  for (const condition of conditions) {
    const cold = [];
    const warm = [];

    for (let run = 0; run < runs; run += 1) {
      const context = await browser.newContext({
        locale: "en-US",
        reducedMotion: "reduce",
        timezoneId: "UTC",
        viewport: condition.viewport,
      });
      const page = await context.newPage();
      await page.goto(baseUrl + "/" + renderer + "/");
      await page.locator("[data-pilot-surface]").waitFor();
      cold.push(await mountedTime(page));
      await page.reload();
      await page.locator("[data-pilot-surface]").waitFor();
      warm.push(await mountedTime(page));
      await context.close();
    }

    measurements.push({
      renderer,
      condition: condition.name,
      viewport: condition.viewport,
      runs,
      coldMilliseconds: summarize(cold),
      warmMilliseconds: summarize(warm),
    });
  }
}

const browserVersion = browser.version();
await browser.close();
process.stdout.write(
  `${JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      runtime: { node: process.version, chromium: browserVersion },
      measurements,
    },
    null,
    2,
  )}\n`,
);

async function mountedTime(page) {
  return page.evaluate(() => {
    const mark = performance.getEntriesByName("renderer-pilot-mounted", "mark").at(-1);
    if (!mark) {
      throw new Error("Renderer pilot mounted mark was not recorded.");
    }
    return mark.startTime;
  });
}

function summarize(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return {
    median: round(quantile(ordered, 0.5)),
    p95: round(quantile(ordered, 0.95)),
    minimum: round(ordered[0]),
    maximum: round(ordered.at(-1)),
  };
}

function quantile(ordered, value) {
  const index = (ordered.length - 1) * value;
  const lower = Math.floor(index);
  const fraction = index - lower;
  return ordered[lower] + (ordered[lower + 1] - ordered[lower]) * fraction;
}

function round(value) {
  return Math.round(value * 10) / 10;
}
