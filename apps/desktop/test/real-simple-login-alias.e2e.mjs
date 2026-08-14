import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { _electron as electron } from "playwright";

const root = process.cwd();
const desktopDirectory = path.resolve(
  root,
  process.env.DESKTOP_BUILD_DIRECTORY ?? "apps/desktop/build",
);
const certificate = fs.readFileSync(path.resolve(root, "apps/web/dev-server.shared.pem"));
const bitwardenEmail = requiredEnvironment("BITWARDEN_EMAIL");
const bitwardenPassword = requiredEnvironment("BITWARDEN_PASSWORD");
const bitwardenApiUrl = new URL(process.env.BITWARDEN_API_URL ?? "http://localhost:4000");
const bitwardenIdentityUrl = new URL(
  process.env.BITWARDEN_IDENTITY_URL ?? "http://localhost:33656",
);
const vaultwarden = process.env.BITWARDEN_DB_DIALECT === "vaultwarden";
const bitwardenApiBaseUrl = serviceBaseUrl(bitwardenApiUrl, vaultwarden ? "/api/" : "/");
const bitwardenIdentityBaseUrl = serviceBaseUrl(
  bitwardenIdentityUrl,
  vaultwarden ? "/identity/" : "/",
);
const bitwardenDbPath = requiredEnvironment("BITWARDEN_DB_PATH");
const simpleLoginUrl = new URL(process.env.SIMPLELOGIN_URL ?? "http://127.0.0.1:32769");
const simpleLoginEmail = requiredEnvironment("SIMPLELOGIN_EMAIL");
const simpleLoginPassword = requiredEnvironment("SIMPLELOGIN_PASSWORD");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bitwarden-alias-desktop-e2e-"));
const existingDeviceIds = readDeviceIds();
const servers = [];
let app;
let simpleLoginToken;
let createdAliasId;
let createdContactId;

try {
  simpleLoginToken = await authenticateSimpleLogin();
  const apiProxy = await startHttpsProxy(bitwardenApiBaseUrl);
  const identityProxy = await startHttpsProxy(bitwardenIdentityBaseUrl);
  servers.push(apiProxy.server, identityProxy.server);

  ({ app } = await launchDesktop());
  let page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.waitForURL(/#\/login$/);

  await page.getByText(/Accessing:/).click();
  await page.getByText("self-hosted", { exact: true }).click();
  await page.getByRole("button", { name: /Custom environment/i }).click();
  const environmentDialog = page.getByRole("dialog");
  await page.locator("#self_hosted_env_settings_form_input_api_url").fill(apiProxy.url.toString());
  await page
    .locator("#self_hosted_env_settings_form_input_identity_url")
    .fill(identityProxy.url.toString());
  await environmentDialog.getByRole("button", { name: "Save", exact: true }).click();
  await environmentDialog.waitFor({ state: "hidden" });

  await page.locator("#email").fill(bitwardenEmail);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator('input[type="password"]').fill(bitwardenPassword);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL(/#\/vault$/, { timeout: 60_000 });
  assert.match(await page.locator("body").innerText(), /Vault/i);

  await page.getByText("Generator", { exact: true }).click();
  const generatorDialog = page.getByRole("dialog");
  await generatorDialog.getByText("Username", { exact: true }).click();
  await generatorDialog.getByTestId("username-type").click();
  await page.getByText("Forwarded email alias", { exact: true }).click();
  await generatorDialog.getByTestId("email-forwarding-service").click();
  await page.getByText("SimpleLogin", { exact: true }).click();
  const tokenInput = generatorDialog.locator('tools-forwarder-settings input[type="password"]');
  const baseUrlInput = generatorDialog.locator(
    'tools-forwarder-settings input[formcontrolname="baseUrl"]',
  );
  await tokenInput.fill(simpleLoginToken);
  await tokenInput.blur();
  await baseUrlInput.fill(simpleLoginUrl.toString());
  await baseUrlInput.blur();
  await generatorDialog
    .locator("footer")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await generatorDialog.waitFor({ state: "hidden" });

  await page.getByText("Email aliases", { exact: true }).click();
  await page.waitForURL(/#\/aliases$/);
  await page.locator('input[name="aliasSearch"]').waitFor();

  const marker = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const hostname = `desktop-${marker}.integration.test`;
  await page.locator('input[name="createHostname"]').fill(hostname);
  await page.getByRole("button", { name: "Create random alias", exact: true }).click();
  await page.waitForFunction(() =>
    /^[^@\s]+@[^@\s]+$/.test(
      document.querySelector("#alias-detail-title")?.textContent?.trim() ?? "",
    ),
  );
  const aliasAddress = (await page.locator("#alias-detail-title").textContent())?.trim() ?? "";
  assert.match(aliasAddress, /^[^@\s]+@[^@\s]+$/);
  const createdAlias = await findSimpleLoginAlias(simpleLoginToken, aliasAddress);
  createdAliasId = createdAlias.id;
  assert.equal(createdAlias.email, aliasAddress);

  await page.locator('input[name="aliasName"]').fill(`Desktop E2E ${marker}`);
  await page.locator('textarea[name="aliasNote"]').fill(`Real Electron ${marker}`);
  await page.locator('input[name="aliasPinned"]').check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await waitForAlias(createdAliasId, (alias) => alias.name === `Desktop E2E ${marker}`);

  await page.getByRole("button", { name: "Disable", exact: true }).click();
  await waitForAlias(createdAliasId, (alias) => alias.enabled === false);
  await page.getByRole("button", { name: "Enable", exact: true }).click();
  await waitForAlias(createdAliasId, (alias) => alias.enabled === true);

  const contactAddress = `desktop-${marker}@contact.lan`;
  await page.locator('input[name="newContact"]').fill(contactAddress);
  await page.getByRole("button", { name: "Create reverse alias", exact: true }).click();
  const contactRow = page.locator("li").filter({ hasText: contactAddress });
  await contactRow.waitFor();
  const contacts = await listSimpleLoginContacts(simpleLoginToken, createdAliasId);
  const contact = contacts.contacts.find((candidate) => candidate.contact === contactAddress);
  assert.ok(contact);
  createdContactId = contact.id;
  assert.match(contact.reverse_alias_address, /^[^@\s]+@[^@\s]+$/);

  await contactRow.getByRole("button", { name: "Block", exact: true }).click();
  await waitForContact(createdAliasId, createdContactId, (candidate) => candidate.block_forward);
  await contactRow.getByRole("button", { name: "Unblock", exact: true }).click();
  await waitForContact(createdAliasId, createdContactId, (candidate) => !candidate.block_forward);

  const mailLifecycle = spawnSync(
    "python3",
    [
      path.resolve(root, "apps/desktop/test/real-simple-login-mail.py"),
      aliasAddress,
      simpleLoginEmail,
      contactAddress,
      contact.reverse_alias_address,
    ],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(
    mailLifecycle.status,
    0,
    `real SimpleLogin SMTP lifecycle failed: ${mailLifecycle.stderr}`,
  );
  assert.match(mailLifecycle.stdout, /REAL_SIMPLELOGIN_INBOUND_FORWARDED/);
  assert.match(mailLifecycle.stdout, /REAL_SIMPLELOGIN_REVERSE_ALIAS_REPLY/);

  await contactRow.getByRole("button", { name: "Delete", exact: true }).click();
  const deleteContactDialog = page.getByRole("dialog");
  await deleteContactDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await contactRow.waitFor({ state: "detached" });
  createdContactId = undefined;

  await page.locator('input[name="recommendWebsite"]').fill(`https://${hostname}/register`);
  await page.getByRole("button", { name: "Find recommendation", exact: true }).click();
  await page
    .locator("p")
    .filter({ hasText: new RegExp(escapeRegExp(aliasAddress)) })
    .waitFor();

  const rendererCrash = page.waitForEvent("crash");
  const lockTriggered = await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("lockAllNow");
    if (!item?.enabled) {
      return false;
    }
    item.click();
    return true;
  });
  assert.equal(lockTriggered, true, "the real Electron lock menu must be enabled");
  await rendererCrash;

  await app.close();
  app = undefined;
  ({ app } = await launchDesktop());
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.waitForURL(/#\/lock$/);
  await page.locator('input[type="password"]').fill(bitwardenPassword);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForURL(/#\/vault$/, { timeout: 60_000 });
  await page.getByText("Email aliases", { exact: true }).click();
  await page.waitForURL(/#\/aliases$/);
  await page.getByText(aliasAddress, { exact: true }).first().waitFor();

  await page.getByText(aliasAddress, { exact: true }).first().click();
  await page.getByRole("button", { name: "Delete", exact: true }).first().click();
  const deleteAliasDialog = page.getByRole("dialog");
  await deleteAliasDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByText(aliasAddress, { exact: true }).first().waitFor({ state: "detached" });
  createdAliasId = undefined;

  await app.close();
  app = undefined;
  assertProfileDoesNotContain(simpleLoginToken);
  assertServiceLogsDoNotContain(simpleLoginToken);

  console.log("REAL_DESKTOP_LOGIN_AND_ALIAS_ROUTE");
  console.log("REAL_DESKTOP_ALIAS_LIFECYCLE");
  console.log("REAL_DESKTOP_INBOUND_AND_REVERSE_REPLY");
  console.log("REAL_DESKTOP_LOCK_RESTART_UNLOCK");
  console.log("REAL_DESKTOP_TOKEN_ABSENT_FROM_STORAGE_AND_LOGS");
  console.log("REAL_DESKTOP_STATE_CLEANED");
} finally {
  await app?.close().catch(() => undefined);
  if (simpleLoginToken && createdContactId != null) {
    await deleteSimpleLoginContact(simpleLoginToken, createdContactId).catch(() => undefined);
  }
  if (simpleLoginToken && createdAliasId != null) {
    await deleteSimpleLoginAlias(simpleLoginToken, createdAliasId).catch(() => undefined);
  }
  await Promise.all(servers.map((server) => closeServer(server)));
  removeCreatedDesktopDevices();
  fs.rmSync(profile, { recursive: true, force: true });
}

async function launchDesktop() {
  const env = {
    ...process.env,
    ELECTRON_IS_DEV: "0",
    ELECTRON_NO_UPDATER: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const launchedApp = await electron.launch({
    args: [desktopDirectory, `--user-data-dir=${profile}`, "--ignore-certificate-errors"],
    env,
  });
  return { app: launchedApp };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function authenticateSimpleLogin() {
  const response = await fetch(new URL("api/auth/login", simpleLoginUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: simpleLoginEmail,
      password: simpleLoginPassword,
      device: `bitwarden-desktop-e2e-${Date.now()}`,
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
  const logs = spawnSync(
    "docker",
    ["logs", process.env.SIMPLELOGIN_APP_CONTAINER ?? "alias-core-sl-app"],
    { encoding: "utf8" },
  );
  assert.equal(logs.status, 0, "SimpleLogin logs must be readable for leakage checks");
  assert.equal(`${logs.stdout}${logs.stderr}`.includes(secret), false);
}

function readDeviceIds() {
  const database = new DatabaseSync(bitwardenDbPath, { readOnly: true });
  const rows =
    process.env.BITWARDEN_DB_DIALECT === "vaultwarden"
      ? database.prepare('SELECT uuid AS "Id" FROM devices').all()
      : database.prepare('SELECT "Id" FROM "Device"').all();
  database.close();
  return new Set(rows.map((row) => row.Id));
}

function removeCreatedDesktopDevices() {
  if (process.env.BITWARDEN_DB_DIALECT === "vaultwarden") {
    // The hosted test database is ephemeral and removed with its pinned container.
    return;
  }
  const database = new DatabaseSync(bitwardenDbPath);
  const created = database
    .prepare('SELECT "Id" FROM "Device" WHERE "Name" = ?')
    .all("macos")
    .filter((row) => !existingDeviceIds.has(row.Id));
  const remove = database.prepare('DELETE FROM "Device" WHERE "Id" = ?');
  for (const device of created) {
    remove.run(device.Id);
  }
  database.close();
}

function serviceBaseUrl(target, fallbackPath) {
  const path = target.pathname === "/" ? fallbackPath : `${target.pathname.replace(/\/+$/, "")}/`;
  return new URL(path, target.origin);
}

async function startHttpsProxy(target) {
  const server = https.createServer(
    { key: certificate, cert: certificate },
    (request, response) => {
      const upstream = http.request(
        new URL((request.url ?? "/").replace(/^\//, ""), target),
        {
          method: request.method,
          headers: { ...request.headers, host: target.host },
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", (error) => {
        response.writeHead(502, { "Content-Type": "text/plain" });
        response.end(error.message);
      });
      request.pipe(upstream);
    },
  );
  await listen(server);
  return { server, url: new URL(`https://localhost:${server.address().port}`) };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
