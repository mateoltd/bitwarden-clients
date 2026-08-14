import { expect, type Page, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";

import { pilotSemanticTokens } from "./shared";

const renderers = ["angular", "react", "lit"] as const;
const themes = ["light", "dark"] as const;

for (const renderer of renderers) {
  test.describe(renderer + " renderer pilot", () => {
    test("has semantic, keyboard, error, cancellation, success, locale, CSP, and axe parity", async ({
      page,
    }) => {
      const response = await openPilot(page, renderer);
      expect(response?.headers()["content-security-policy"]).toContain("default-src 'none'");
      expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");

      const surface = page.locator("[data-pilot-surface]");
      await expect(surface).toHaveAttribute("data-renderer", renderer);
      await expect(page.getByRole("heading", { name: "No items found", level: 1 })).toBeVisible();
      await expect(surface).toHaveAttribute("aria-busy", "false");

      const refresh = page.getByRole("button", { name: "Refresh", exact: true });
      await refresh.focus();
      await refresh.press("Enter");
      await expect(
        page.getByRole("alert").filter({ hasText: "Items could not be refreshed. Try again." }),
      ).toBeVisible();
      await expect(refresh).toBeFocused();

      await refresh.press("Enter");
      await expect(surface).toHaveAttribute("aria-busy", "true");
      await expect(refresh).toBeDisabled();
      const cancel = page.getByRole("button", { name: "Cancel refresh" });
      await expect(cancel).toBeFocused();
      await cancel.press("Enter");
      await expect(page.getByRole("status")).toHaveText("Refresh canceled.");
      await expect(surface).toHaveAttribute("aria-busy", "false");
      await expect(refresh).toBeFocused();

      await refresh.press("Enter");
      await expect(page.getByRole("status")).toHaveText("Items refreshed. No items found.");

      await page.getByLabel("Pilot locale").selectOption("es-ES");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "No se encontraron elementos",
      );
      await expect(surface).toHaveAttribute("lang", "es-ES");
      await page.getByLabel("Pilot locale").selectOption("ar");
      await expect(surface).toHaveAttribute("dir", "rtl");
      await expect(page.getByRole("button", { name: "تحديث" })).toBeVisible();

      await expectAccessible(page);
    });

    test("reflows at narrow width, 200% zoom, forced colors, and RTL", async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.emulateMedia({ forcedColors: "active" });
      await openPilot(page, renderer);
      await page.getByLabel("Pilot locale").selectOption("ar");
      await page.evaluate(() => {
        document.body.style.zoom = "200%";
      });
      await expect(page.getByRole("button", { name: "تحديث" })).toBeVisible();
      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hasHorizontalOverflow).toBe(false);
      await expectAccessible(page);
    });
  });
}

test("keeps DOM semantics and computed semantic tokens equal across renderers and themes", async ({
  browser,
}) => {
  const fingerprints = new Map<string, string>();
  const tokenMaps = new Map<string, string>();

  for (const renderer of renderers) {
    for (const theme of themes) {
      const page = await browser.newPage();
      await openPilot(page, renderer);
      await page.getByLabel("Pilot theme").selectOption(theme);
      fingerprints.set(renderer + ":" + theme, JSON.stringify(await semanticFingerprint(page)));
      tokenMaps.set(renderer + ":" + theme, JSON.stringify(await computedTokens(page)));
      await page.close();
    }
  }

  for (const theme of themes) {
    const angularFingerprint = fingerprints.get("angular:" + theme);
    const angularTokens = tokenMaps.get("angular:" + theme);
    for (const renderer of renderers) {
      expect(fingerprints.get(renderer + ":" + theme)).toBe(angularFingerprint);
      expect(tokenMaps.get(renderer + ":" + theme)).toBe(angularTokens);
    }
  }
  expect(tokenMaps.get("angular:light")).not.toBe(tokenMaps.get("angular:dark"));
});

test("renders every implementation inside the existing Angular Storybook", async ({ page }) => {
  for (const renderer of renderers) {
    await page.goto(
      "http://localhost:6006/iframe.html?id=ui-redesign-renderer-pilot--" +
        renderer +
        "&viewMode=story&globals=theme:light",
    );
    await expect(page.locator("[data-pilot-surface]")).toHaveAttribute("data-renderer", renderer);
    await expect(page.getByRole("heading", { name: "No items found", level: 1 })).toBeVisible();
    await expectAccessible(page);
  }
});

async function openPilot(page: Page, renderer: (typeof renderers)[number]) {
  const response = await page.goto("/" + renderer + "/");
  await page.locator("[data-pilot-surface]").waitFor({ state: "visible" });
  return response;
}

async function semanticFingerprint(page: Page) {
  return page.locator("[data-pilot-surface]").evaluate((surface) =>
    Array.from(surface.querySelectorAll("h1, p, button")).map((element) => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      action: element.getAttribute("data-action"),
      type: element.getAttribute("type"),
    })),
  );
}

async function computedTokens(page: Page) {
  return page.evaluate((tokens) => {
    const result: Record<string, string> = {};
    for (const token of tokens) {
      const probe = document.createElement("span");
      probe.style.color = "var(" + token + ")";
      document.body.append(probe);
      result[token] = getComputedStyle(probe).color;
      probe.remove();
    }
    return result;
  }, Object.values(pilotSemanticTokens));
}

async function expectAccessible(page: Page): Promise<void> {
  await injectAxe(page);
  await checkA11y(
    page,
    undefined,
    { detailedReport: true, detailedReportOptions: { html: true } },
    false,
    "v2",
  );
}
