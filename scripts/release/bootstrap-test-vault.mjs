import assert from "node:assert/strict";

import { chromium } from "playwright";

const vaultUrl = new URL(process.env.BITWARDEN_WEB_URL ?? "http://localhost:18080");
const email = process.env.BITWARDEN_EMAIL;
const password = process.env.BITWARDEN_PASSWORD;
assert.ok(email, "BITWARDEN_EMAIL is required");
assert.ok(password, "BITWARDEN_PASSWORD is required");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  page.setDefaultTimeout(30_000);
  await page.goto(new URL("/#/register", vaultUrl).toString());

  const startEmail = page.locator("#register-start_form_input_email");
  const classicEmail = page.locator("#email");
  await startEmail.or(classicEmail).first().waitFor({ state: "visible" });
  if (await startEmail.isVisible().catch(() => false)) {
    await startEmail.fill(email);
    await page.locator("#register-start_form_input_name").fill("Alias Release Test");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }

  if (await classicEmail.isVisible().catch(() => false)) {
    await classicEmail.fill(email);
    const name = page.locator("#name");
    if (await name.isVisible().catch(() => false)) await name.fill("Alias Release Test");
  }

  const newPassword = page.locator("#input-password-form_new-password");
  const classicPassword = page.locator("#masterPassword");
  await newPassword.or(classicPassword).first().waitFor({ state: "visible" });
  if (await newPassword.isVisible().catch(() => false)) {
    await newPassword.fill(password);
    await page.locator("#input-password-form_new-password-confirm").fill(password);
    const breachCheck = page.locator("#input-password-form_check-for-breaches");
    if (await breachCheck.isChecked().catch(() => false)) await breachCheck.uncheck();
  } else {
    await classicPassword.fill(password);
    await page.locator("#confirmMasterPassword").fill(password);
    const breachCheck = page.locator("#checkForBreaches");
    if (await breachCheck.isChecked().catch(() => false)) await breachCheck.uncheck();
  }

  await page.getByRole("button", { name: /Create account|Submit/i }).click();
  await page.waitForURL(/#\/(login|vault|setup-extension)/, { timeout: 60_000 });
  console.log(`Created ephemeral test vault account ${email}`);
} finally {
  await browser.close();
}
