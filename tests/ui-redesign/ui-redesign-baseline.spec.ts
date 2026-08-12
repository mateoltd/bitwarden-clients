import { expect, Page, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";

const MAIN_STORYBOOK = "http://localhost:6006";
const AUTOFILL_STORYBOOK = "http://localhost:6007";

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 390, height: 844 },
] as const;

async function openStory(page: Page, storyId: string, storybook = MAIN_STORYBOOK) {
  await page.goto(`${storybook}/iframe.html?id=${storyId}&viewMode=story&globals=theme:light`);
  await page.locator("#storybook-root").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.fonts.status === "loaded");
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
    `,
  });
  await injectAxe(page);
}

async function expectAccessible(page: Page, disabledRules: string[] = []) {
  await checkA11y(
    page,
    {
      include: ["#storybook-root", ".cdk-overlay-container"],
      exclude: [".cdk-visually-hidden"],
    },
    {
      detailedReport: true,
      detailedReportOptions: { html: true },
      axeOptions: {
        rules: Object.fromEntries(disabledRules.map((rule) => [rule, { enabled: false }])),
      },
    },
    false,
    "v2",
  );
}

async function expectBaseline(page: Page, name: string) {
  await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false });
}

for (const viewport of viewports) {
  test.describe(`${viewport.name} shared surfaces`, () => {
    test.use({ viewport });

    test(`authentication and keyboard flow at ${viewport.name} width`, async ({ page }) => {
      await openStory(page, "auth-login--email-entry");

      const email = page.getByLabel("Email address");
      await expect(email).toBeVisible();
      await email.focus();
      await email.pressSequentially("redesign@example.com");
      await email.press("Tab");
      await expect(page.locator(":focus")).not.toHaveJSProperty("tagName", "BODY");
      await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();

      await expectAccessible(page);
      await expectBaseline(page, `authentication-${viewport.name}`);
    });

    test(`unlock and focus order at ${viewport.name} width`, async ({ page }) => {
      await openStory(page, "auth-unlock--master-password");

      const password = page.getByLabel("Master password");
      await expect(password).toBeVisible();
      await password.focus();
      await password.pressSequentially("correct horse battery staple");
      await password.press("Tab");
      await expect(page.locator(":focus")).not.toHaveJSProperty("tagName", "BODY");
      await expect(page.getByRole("button", { name: "Unlock" })).toBeEnabled();

      await expectAccessible(page);
      await expectBaseline(page, `unlock-${viewport.name}`);
    });

    test(`vault list at ${viewport.name} width`, async ({ page }) => {
      await openStory(page, "web-vault-items--individual");

      await expect(page.getByText("Vault item 0", { exact: true })).toBeVisible();
      await expect(page.getByText("Vault item 12", { exact: true })).toBeVisible();
      await expect(page.getByRole("checkbox").first()).toBeVisible();

      await expectAccessible(page);
      await expectBaseline(page, `vault-list-${viewport.name}`);
    });

    test(`item edit at ${viewport.name} width`, async ({ page }) => {
      await openStory(page, "vault-cipher-form--edit");

      const name = page.getByRole("textbox", { name: /^Item name/ });
      await expect(name).toHaveValue("Test Cipher");
      await name.focus();
      await name.press("Tab");
      await expect(page.locator(":focus")).not.toHaveJSProperty("tagName", "BODY");
      await expect(page.getByRole("textbox", { name: "Username" })).toHaveValue("testuser");

      await expectAccessible(page);
      await expectBaseline(page, `item-edit-${viewport.name}`);
    });

    test(`settings at ${viewport.name} width`, async ({ page }) => {
      await openStory(page, "admin-console-organizations-settings-account--default");

      await expect(page.getByRole("textbox", { name: /^Organization name/ })).toHaveValue(
        "Acme Corp",
      );
      await expect(page.getByRole("heading", { name: "Collection management" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save" })).toHaveCount(2);

      await expectAccessible(page);
      await expectBaseline(page, `settings-${viewport.name}`);
    });
  });
}

test.describe("browser extension surfaces", () => {
  test("vault search filters the rendered popup with the keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 760 });
    await openStory(page, "browser-popup-layout--filterable-table-list");

    const search = page.getByRole("searchbox", { name: "Search" });
    await search.focus();
    await search.pressSequentially("GitHub");
    await expect(page.getByText("GitHub", { exact: true })).toBeVisible();
    await expect(page.getByText("Amazon", { exact: true })).toBeHidden();
    await search.press("Tab");
    await expect(page.locator(":focus")).not.toHaveJSProperty("tagName", "BODY");

    await expectAccessible(page, [
      "aria-allowed-role",
      "empty-table-header",
      "scrollable-region-focusable",
    ]);
    await expectBaseline(page, "browser-vault-search");
  });

  test("narrow popup shell retains its primary controls", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 720 });
    await openStory(page, "browser-popup-layout--narrow-width");

    await expect(page.getByRole("heading", { name: "Test" })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add" })).toBeVisible();

    await expectAccessible(page);
    await expectBaseline(page, "browser-popup-narrow");
  });

  test("autofill item list exposes fill and view actions", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openStory(page, "components-inline-menu-cipher-list--default", AUTOFILL_STORYBOOK);

    await expect(page.getByText("bitwarden.com", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /fill credentials for bitwarden\.com/i }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /view bitwarden\.com/i })).toBeVisible();

    await expectAccessible(page);
    await expectBaseline(page, "autofill-item-list");
  });

  test("autofill generator is keyboard reachable", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 520 });
    await openStory(
      page,
      "components-inline-menu-password-generator--fill-generated-password",
      AUTOFILL_STORYBOOK,
    );

    const fill = page.getByRole("button", { name: /fill generated password/i });
    await expect(fill).toBeVisible();
    await fill.focus();
    await fill.press("Tab");
    await expect(page.locator(":focus")).not.toHaveJSProperty("tagName", "BODY");

    await expectAccessible(page);
    await expectBaseline(page, "autofill-generator");
  });

  test("autofill save prompt remains operable at constrained width", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 360 });
    await openStory(page, "components-inline-menu-prompt--save-login", AUTOFILL_STORYBOOK);

    const save = page.getByRole("button", { name: /save to bitwarden/i });
    await expect(save).toBeVisible();
    await save.focus();
    await expect(save).toBeFocused();

    await expectAccessible(page);
    await expectBaseline(page, "autofill-save-prompt");
  });
});
