import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { chromium } from "playwright";

const root = process.cwd();
const browserExecutable =
  process.env.CHROMIUM_PATH ??
  path.join(
    os.homedir(),
    "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  );
const webUrl = new URL(process.env.WEB_URL ?? "https://localhost:8080");
const bitwardenEmail = requiredEnvironment("BITWARDEN_EMAIL");
const bitwardenPassword = requiredEnvironment("BITWARDEN_PASSWORD");
const bitwardenDbPath = requiredEnvironment("BITWARDEN_DB_PATH");
const simpleLoginUrl = new URL(process.env.SIMPLELOGIN_URL ?? "http://127.0.0.1:32769");
const simpleLoginEmail = requiredEnvironment("SIMPLELOGIN_EMAIL");
const simpleLoginPassword = requiredEnvironment("SIMPLELOGIN_PASSWORD");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bitwarden-alias-web-e2e-"));
const existingDeviceIds = readDeviceIds();
let context;
let simpleLoginToken;
let createdAliasId;
let createdContactId;

try {
  simpleLoginToken = await authenticateSimpleLogin();
  context = await chromium.launchPersistentContext(profile, {
    executablePath: browserExecutable,
    headless: true,
    ignoreHTTPSErrors: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  });
  context.setDefaultTimeout(30_000);
  const page = context.pages()[0] ?? (await context.newPage());

  await page.goto(new URL("#/login", webUrl).toString());
  await page.locator("#email").fill(bitwardenEmail);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator('input[type="password"]:visible').fill(bitwardenPassword);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForFunction(() => ["#/vault", "#/setup-extension"].includes(location.hash), {
    timeout: 60_000,
  });
  if (new URL(page.url()).hash === "#/setup-extension") {
    await page.getByRole("button", { name: "Add it later", exact: true }).click();
    const extensionDialog = page.getByRole("dialog");
    await extensionDialog.getByText("Skip to web app", { exact: true }).click();
  }
  await page.waitForURL(/#\/vault$/, { timeout: 60_000 });
  await page.waitForTimeout(1_000);
  await dismissBlockingOverlays(page);

  await page.goto(new URL("#/tools/generator", webUrl).toString());
  await dismissBlockingOverlays(page);
  await page.getByText("Username", { exact: true }).click();
  await page.getByTestId("username-type").click();
  await page.getByText("Forwarded email alias", { exact: true }).click();
  await page.getByTestId("email-forwarding-service").click();
  await page.getByText("SimpleLogin", { exact: true }).click();
  const tokenInput = page.locator('tools-forwarder-settings input[type="password"]');
  const baseUrlInput = page.locator('tools-forwarder-settings input[formcontrolname="baseUrl"]');
  await tokenInput.fill(simpleLoginToken);
  await tokenInput.blur();
  await baseUrlInput.fill(simpleLoginUrl.toString());
  await baseUrlInput.blur();

  await page.goto(new URL("#/tools/aliases", webUrl).toString());
  await page.locator('input[name="query"]').waitFor();
  assert.equal(await page.getByTestId("alias-domains").isVisible(), true);

  const marker = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const hostname = `web-${marker}.integration.test`;
  await page.locator('input[name="website"]').fill(`https://${hostname}/register`);
  await page.getByRole("button", { name: "Recommend an alias", exact: true }).click();
  await page.getByTestId("alias-recommendation").waitFor();
  await page
    .getByTestId("alias-recommendation")
    .getByRole("button", { name: "Create email alias", exact: true })
    .click();
  await page.getByTestId("alias-detail").waitFor();
  const aliasAddress = (await page.locator("#alias-detail-heading").textContent())?.trim() ?? "";
  assert.match(aliasAddress, /^[^@\s]+@[^@\s]+$/);
  const createdAlias = await findSimpleLoginAlias(simpleLoginToken, aliasAddress);
  createdAliasId = createdAlias.id;
  assert.equal(createdAlias.email, aliasAddress);

  await page.locator('input[name="aliasName"]').fill(`Web E2E ${marker}`);
  await page.locator('input[name="aliasNote"]').fill(`Real browser ${marker}`);
  await page.locator('input[name="pinned"]').check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await waitForAlias(createdAliasId, (alias) => alias.name === `Web E2E ${marker}`);

  await page.getByRole("button", { name: "Turn off", exact: true }).click();
  await waitForAlias(createdAliasId, (alias) => alias.enabled === false);
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await waitForAlias(createdAliasId, (alias) => alias.enabled === true);

  const contactAddress = `web-${marker}@example.net`;
  await page.locator('input[name="reverseAliasContact"]').fill(contactAddress);
  await page.getByRole("button", { name: "Create reverse alias", exact: true }).click();
  const contactRow = page.getByTestId("contact-list").locator("tr").filter({
    hasText: contactAddress,
  });
  await contactRow.waitFor();
  const contacts = await listSimpleLoginContacts(simpleLoginToken, createdAliasId);
  const contact = contacts.contacts.find((candidate) => candidate.contact === contactAddress);
  assert.ok(contact);
  createdContactId = contact.id;
  assert.match(contact.reverse_alias_address, /^[^@\s]+@[^@\s]+$/);

  await contactRow.getByRole("button", { name: "Block", exact: true }).click();
  await waitForContact(createdAliasId, createdContactId, (candidate) => candidate.block_forward);
  await contactRow.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await contactRow.waitFor({ state: "detached" });
  createdContactId = undefined;

  await page.locator('input[name="website"]').fill(`https://${hostname}/sign-up`);
  await page.getByRole("button", { name: "Recommend an alias", exact: true }).click();
  await page
    .getByTestId("alias-recommendation")
    .getByRole("button", { name: aliasAddress, exact: true })
    .waitFor();

  await page.locator('input[name="query"]').fill(aliasAddress);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByTestId("alias-list").getByText(aliasAddress, { exact: true }).waitFor();

  await page
    .getByTestId("alias-detail")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByTestId("alias-detail").waitFor({ state: "detached" });
  createdAliasId = undefined;

  await context.close();
  context = undefined;
  assertProfileDoesNotContain(simpleLoginToken);
  assertServiceLogsDoNotContain(simpleLoginToken);

  console.log("REAL_WEB_LOGIN_AND_ALIAS_ROUTE");
  console.log("REAL_WEB_ALIAS_LIFECYCLE");
  console.log("REAL_WEB_RECOMMENDATION_AND_REUSE");
  console.log("REAL_WEB_TOKEN_ABSENT_FROM_STORAGE_AND_LOGS");
  console.log("REAL_WEB_STATE_CLEANED");
} finally {
  await context?.close().catch(() => undefined);
  if (simpleLoginToken && createdContactId != null) {
    await deleteSimpleLoginContact(simpleLoginToken, createdContactId).catch(() => undefined);
  }
  if (simpleLoginToken && createdAliasId != null) {
    await deleteSimpleLoginAlias(simpleLoginToken, createdAliasId).catch(() => undefined);
  }
  removeCreatedWebDevices();
  fs.rmSync(profile, { recursive: true, force: true });
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function dismissBlockingOverlays(page) {
  const backdrop = page.locator(".cdk-overlay-backdrop.cdk-overlay-backdrop-showing");
  for (let attempt = 0; attempt < 3 && (await backdrop.first().isVisible()); attempt++) {
    const dialog = page.getByRole("dialog");
    const skipTour = dialog.getByRole("button", { name: "Skip", exact: true });
    const skipExtension = dialog.getByRole("link", { name: "Skip to web app", exact: true });
    if (await skipTour.isVisible()) {
      await skipTour.click();
    } else if (await skipExtension.isVisible()) {
      await skipExtension.click();
      await page.waitForTimeout(1_000);
      await page.reload({ waitUntil: "domcontentloaded" });
    } else {
      throw new Error(
        `Unexpected modal blocked the real web workflow: ${JSON.stringify(await dialog.allInnerTexts())}`,
      );
    }
    await backdrop
      .first()
      .waitFor({ state: "hidden", timeout: 3_000 })
      .catch(() => undefined);
  }
  assert.equal(
    await backdrop.first().isVisible(),
    false,
    "no modal overlay may block the real web workflow",
  );
}

async function authenticateSimpleLogin() {
  const response = await fetch(new URL("api/auth/login", simpleLoginUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: simpleLoginEmail,
      password: simpleLoginPassword,
      device: `bitwarden-web-e2e-${Date.now()}`,
    }),
  });
  assert.equal(response.ok, true, `SimpleLogin authentication failed (${response.status})`);
  const json = await response.json();
  assert.equal(typeof json.api_key, "string");
  return json.api_key;
}

async function findSimpleLoginAlias(token, address) {
  const response = await fetch(new URL("api/v2/aliases?page_id=0", simpleLoginUrl), {
    method: "POST",
    headers: { Authentication: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: address }),
  });
  assert.equal(response.ok, true, `SimpleLogin search failed (${response.status})`);
  const json = await response.json();
  const alias = json.aliases?.find((candidate) => candidate.email === address);
  assert.ok(alias, `SimpleLogin search must return ${address}`);
  return alias;
}

async function getSimpleLoginAlias(token, id) {
  const response = await fetch(new URL(`api/aliases/${id}`, simpleLoginUrl), {
    headers: { Authentication: token },
  });
  assert.equal(response.ok, true, `SimpleLogin detail failed (${response.status})`);
  const json = await response.json();
  return { ...json, enabled: json.enabled === true && json.disabled !== true };
}

async function waitForAlias(id, predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const alias = await getSimpleLoginAlias(simpleLoginToken, id);
    if (predicate(alias)) {
      return alias;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`SimpleLogin alias ${id} did not reach the expected state`);
}

async function listSimpleLoginContacts(token, aliasId) {
  const response = await fetch(
    new URL(`api/aliases/${aliasId}/contacts?page_id=0`, simpleLoginUrl),
    {
      headers: { Authentication: token },
    },
  );
  assert.equal(response.ok, true, `SimpleLogin contacts failed (${response.status})`);
  return response.json();
}

async function waitForContact(aliasId, contactId, predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const contacts = await listSimpleLoginContacts(simpleLoginToken, aliasId);
    const contact = contacts.contacts.find((candidate) => candidate.id === contactId);
    if (contact && predicate(contact)) {
      return contact;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`SimpleLogin contact ${contactId} did not reach the expected state`);
}

async function deleteSimpleLoginContact(token, id) {
  const response = await fetch(new URL(`api/contacts/${id}`, simpleLoginUrl), {
    method: "DELETE",
    headers: { Authentication: token },
  });
  assert.equal(response.ok, true, `SimpleLogin contact cleanup failed (${response.status})`);
}

async function deleteSimpleLoginAlias(token, id) {
  const response = await fetch(new URL(`api/aliases/${id}`, simpleLoginUrl), {
    method: "DELETE",
    headers: { Authentication: token },
  });
  assert.equal(response.ok, true, `SimpleLogin alias cleanup failed (${response.status})`);
}

function assertProfileDoesNotContain(secret) {
  const pending = [profile];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        assert.equal(fs.readFileSync(entryPath).includes(Buffer.from(secret)), false);
      }
    }
  }
}

function assertServiceLogsDoNotContain(secret) {
  const logs = spawnSync("docker", ["logs", "alias-core-sl-app"], { encoding: "utf8" });
  assert.equal(logs.status, 0, "SimpleLogin logs must be readable for leakage checks");
  assert.equal(`${logs.stdout}${logs.stderr}`.includes(secret), false);
}

function readDeviceIds() {
  const database = new DatabaseSync(bitwardenDbPath, { readOnly: true });
  const rows = database.prepare('SELECT "Id" FROM "Device"').all();
  database.close();
  return new Set(rows.map((row) => row.Id));
}

function removeCreatedWebDevices() {
  const database = new DatabaseSync(bitwardenDbPath);
  const created = database
    .prepare('SELECT "Id" FROM "Device"')
    .all()
    .filter((row) => !existingDeviceIds.has(row.Id));
  const remove = database.prepare('DELETE FROM "Device" WHERE "Id" = ?');
  for (const device of created) {
    remove.run(device.Id);
  }
  database.close();
}
