import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { chromium } from "playwright";

const root = process.cwd();
const extensionDirectory = path.resolve(
  root,
  process.env.BROWSER_EXTENSION_DIRECTORY ?? "apps/browser/build",
);
const registrationFixture = path.resolve(root, "apps/browser/test/alias-registration.html");
const certificate = fs.readFileSync(path.resolve(root, "apps/web/dev-server.shared.pem"));
const browserExecutable =
  process.env.CHROMIUM_PATH ??
  path.join(
    os.homedir(),
    "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  );

const bitwardenEmail = requiredEnvironment("BITWARDEN_EMAIL");
const bitwardenPassword = requiredEnvironment("BITWARDEN_PASSWORD");
const bitwardenApiUrl = new URL(process.env.BITWARDEN_API_URL ?? "http://localhost:4000");
const bitwardenIdentityUrl = new URL(
  process.env.BITWARDEN_IDENTITY_URL ?? "http://localhost:33656",
);
const bitwardenDbPath = requiredEnvironment("BITWARDEN_DB_PATH");
const simpleLoginUrl = new URL(process.env.SIMPLELOGIN_URL ?? "http://127.0.0.1:32769");
const simpleLoginEmail = requiredEnvironment("SIMPLELOGIN_EMAIL");
const simpleLoginPassword = requiredEnvironment("SIMPLELOGIN_PASSWORD");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bitwarden-alias-browser-e2e-"));
const servers = [];
let context;
let extensionId;
let popup;
let worker;
let simpleLoginToken;
let bitwardenAuthorization;
let createdAliasId;
let createdCipherId;
let simpleLoginCreateRequests = 0;
const safeDiagnostics = [];

try {
  simpleLoginToken = await authenticateSimpleLogin();
  const apiProxy = await startHttpsProxy(bitwardenApiUrl);
  const identityProxy = await startHttpsProxy(bitwardenIdentityUrl);
  const registrationServer = await startRegistrationServer();
  const registrationHostname = `alias-browser-${Date.now()}.test`;
  const registrationUrl = new URL(registrationServer.url);
  registrationUrl.hostname = registrationHostname;
  servers.push(apiProxy.server, identityProxy.server, registrationServer.server);

  const launchOptions = {
    executablePath: browserExecutable,
    headless: false,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
      `--host-resolver-rules=MAP ${registrationHostname} 127.0.0.1`,
    ],
  };
  context = await chromium.launchPersistentContext(profile, launchOptions);
  context.setDefaultTimeout(15_000);
  observeContext(context, apiProxy);

  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  observeWorker(worker);
  extensionId = new URL(worker.url()).host;
  popup = await context.newPage();

  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await popup.waitForTimeout(2_000);
  const loginButton = popup.locator("button").filter({ hasText: "Log in" });
  if (await loginButton.isVisible().catch(() => false)) {
    await loginButton.click();
  } else {
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/login`);
  }
  await popup.locator("#email").waitFor({ timeout: 30_000 });
  await popup.locator("environment-selector").getByRole("button").last().click();
  await popup.getByRole("menuitem", { name: /self-hosted/i }).click();
  await popup.getByRole("button", { name: /Custom environment/i }).click();
  await popup.locator("#self_hosted_env_settings_form_input_api_url").fill(apiProxy.url.toString());
  await popup
    .locator("#self_hosted_env_settings_form_input_identity_url")
    .fill(identityProxy.url.toString());
  await popup.getByRole("button", { name: "Save", exact: true }).click();
  await popup.getByRole("dialog").waitFor({ state: "hidden" });

  await popup.locator("#email").fill(bitwardenEmail);
  await popup.getByRole("button", { name: "Continue", exact: true }).click();
  await popup.locator('input[type="password"]').fill(bitwardenPassword);
  await popup.getByRole("button", { name: "Log in", exact: true }).click();
  await popup.waitForURL(/#\/tabs\//, { timeout: 30_000 });
  assert.match(await popup.locator("body").innerText(), /Vault/i);

  if (process.env.BITWARDEN_CLEANUP_CIPHER_ID) {
    assert.ok(bitwardenAuthorization);
    await permanentlyDeleteBitwardenCipher(
      bitwardenAuthorization,
      process.env.BITWARDEN_CLEANUP_CIPHER_ID,
    );
  }

  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/tabs/generator`);
  await popup.waitForTimeout(1_000);
  await popup.getByText("Username", { exact: true }).click();
  await popup.waitForTimeout(500);
  await popup.getByTestId("username-type").click();
  await popup.waitForTimeout(300);
  await popup.getByText("Forwarded email alias", { exact: true }).click();
  await popup.waitForTimeout(300);
  await popup.getByTestId("email-forwarding-service").click();
  await popup.getByText("SimpleLogin", { exact: true }).click();
  await popup.waitForTimeout(300);
  const tokenInput = popup.locator('tools-forwarder-settings input[type="password"]');
  const baseUrlInput = popup.locator('tools-forwarder-settings input[formcontrolname="baseUrl"]');
  await tokenInput.fill(simpleLoginToken);
  await tokenInput.blur();
  await popup.waitForTimeout(1_000);
  assert.equal(await tokenInput.inputValue(), simpleLoginToken);
  await baseUrlInput.fill(simpleLoginUrl.toString());
  await baseUrlInput.blur();
  await popup.waitForTimeout(2_000);
  assert.equal(await tokenInput.inputValue(), simpleLoginToken);
  assert.equal(await baseUrlInput.inputValue(), simpleLoginUrl.toString());

  const browserStorage = JSON.stringify(
    await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(null, resolve))),
  );
  assert.equal(browserStorage.includes(simpleLoginToken), false);

  const registration = await context.newPage();
  registration.on("console", (message) => {
    if (message.type() === "error") {
      recordDiagnostic("REGISTRATION_CONSOLE_ERROR", message.text());
    }
  });
  await registration.goto(registrationUrl.toString());
  await registration.locator("#email").focus();
  await registration.waitForTimeout(1_500);
  await registration.screenshot({ path: "/tmp/alias-registration.png" });
  await registration.locator("#email").press("ArrowDown");
  await registration.waitForTimeout(300);
  await registration.keyboard.press("Enter");
  await registration.waitForFunction(() => document.querySelector("#email")?.value, undefined, {
    timeout: 15_000,
  });
  const aliasAddress = await registration.locator("#email").inputValue();
  assert.match(aliasAddress, /^[^@\s]+@[^@\s]+$/);

  const alias = await findSimpleLoginAlias(simpleLoginToken, aliasAddress);
  assert.equal(typeof alias.id, "number");
  assert.equal(alias.email, aliasAddress);
  createdAliasId = alias.id;
  const persistedAlias = await getSimpleLoginAlias(simpleLoginToken, alias.id);
  assert.equal(persistedAlias.email, aliasAddress);
  assert.equal(simpleLoginCreateRequests, 1);

  const reuse = await context.newPage();
  await reuse.goto(registrationUrl.toString());
  await reuse.locator("#email").focus();
  await reuse.waitForTimeout(3_000);
  await reuse.locator("#email").press("ArrowDown");
  await reuse.waitForTimeout(500);
  await reuse.keyboard.press("Enter");
  await reuse.waitForFunction(
    (address) => document.querySelector("#email")?.value === address,
    aliasAddress,
    { timeout: 15_000 },
  );
  assert.equal(await reuse.locator("#email").inputValue(), aliasAddress);
  assert.equal(simpleLoginCreateRequests, 1, "hostname reuse must not create a second alias");
  await reuse.close();

  const marker = `Alias browser e2e ${Date.now()}`;
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/tabs/generator`);
  await popup.locator("bit-toggle").filter({ hasText: "Password" }).click();
  const loginPassword = (await popup.locator("bit-color-password").textContent())?.trim() ?? "";
  assert.ok(loginPassword.length >= 12, "the extension must render a generated password");
  await registration.locator("#password").fill(loginPassword);
  await registration.locator("#email").focus();
  await registration.locator("#email").press("ArrowDown");
  await registration.waitForTimeout(500);
  await registration.screenshot({ path: "/tmp/alias-registration-save.png" });
  const addEditPagePromise = context.waitForEvent("page");
  const passwordBox = await registration.locator("#password").boundingBox();
  assert.ok(passwordBox);
  await registration.mouse.click(
    passwordBox.x + Math.min(100, passwordBox.width / 2),
    passwordBox.y + passwordBox.height + 20,
  );
  const addEditPage = await addEditPagePromise;
  await addEditPage.waitForLoadState();
  await addEditPage.waitForTimeout(1_000);

  assert.equal(
    await addEditPage.getByLabel("Username", { exact: true }).inputValue(),
    aliasAddress,
  );
  assert.equal(
    await addEditPage.getByLabel("Password", { exact: true }).inputValue(),
    loginPassword,
  );
  assert.equal(
    await addEditPage.getByLabel("Website (URI)", { exact: true }).inputValue(),
    registrationUrl.toString(),
  );
  await addEditPage.locator('input[formcontrolname="name"]').fill(marker);
  await addEditPage.screenshot({ path: "/tmp/alias-login-binding.png" });

  const cipherResponsePromise = context.waitForEvent(
    "response",
    (response) =>
      response.request().method() === "POST" && /\/ciphers\/?(?:\?|$)/.test(response.url()),
  );
  await addEditPage.getByRole("button", { name: "Save", exact: true }).click();
  const cipherResponse = await cipherResponsePromise;
  assert.equal(cipherResponse.ok(), true);
  const encryptedCipher = await cipherResponse.json();
  const cipherId = encryptedCipher.id;
  assert.equal(typeof cipherId, "string");
  createdCipherId = cipherId;
  const encryptedVaultPayload = JSON.stringify(encryptedCipher);
  assert.equal(encryptedVaultPayload.includes(simpleLoginToken), false);
  assert.equal(encryptedVaultPayload.includes(aliasAddress), false);
  assert.equal(
    encryptedCipher.fields?.length,
    1,
    "The encrypted cipher must contain exactly one reserved alias-binding field",
  );

  const database = new DatabaseSync(bitwardenDbPath, { readOnly: true });
  const persistedCipher = database
    .prepare('SELECT "Data" FROM "Cipher" WHERE lower("Id") = lower(?)')
    .get(cipherId);
  database.close();
  assert.ok(persistedCipher);
  assert.equal(persistedCipher.Data.includes(simpleLoginToken), false);
  assert.equal(persistedCipher.Data.includes(aliasAddress), false);

  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/tabs/vault`);
  await popup.getByText(marker, { exact: true }).waitFor({ timeout: 20_000 });
  const vaultItem = popup.getByText(marker, { exact: true }).locator("xpath=ancestor::bit-item");
  await vaultItem.getByRole("button", { name: "More options" }).click();
  await popup.screenshot({ path: "/tmp/alias-bound-menu.png" });
  await popup.getByRole("menuitem", { name: "Manage bound alias", exact: true }).click();
  await popup.waitForURL(new RegExp(`#\/email-aliases\/${alias.id}$`));
  await popup.waitForFunction(
    (address) =>
      document.querySelector('[data-testid="alias-address"]')?.textContent?.trim() === address,
    aliasAddress,
  );
  assert.equal((await popup.getByTestId("alias-address").textContent())?.trim(), aliasAddress);
  await popup.getByText("No reverse aliases yet.", { exact: true }).waitFor();

  const reverseContact = `alias-browser-${Date.now()}@example.com`;
  const createdContact = await createSimpleLoginContact(simpleLoginToken, alias.id, reverseContact);
  assert.equal(createdContact.contact, reverseContact);
  await popup.reload();
  await popup.getByText(reverseContact, { exact: true }).waitFor();

  const deleteContactResponse = context.waitForEvent(
    "response",
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().includes(`/api/contacts/${createdContact.id}`),
  );
  await popup
    .getByText(reverseContact, { exact: true })
    .locator("xpath=ancestor::bit-item")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  assert.equal((await deleteContactResponse).ok(), true);
  await popup.getByText(reverseContact, { exact: true }).waitFor({ state: "detached" });

  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/account-switcher`);
  await popup.getByRole("button", { name: "Lock now", exact: true }).click();
  await context.close().catch(() => undefined);
  context = await chromium.launchPersistentContext(profile, launchOptions);
  context.setDefaultTimeout(15_000);
  observeContext(context, apiProxy);
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  observeWorker(worker);
  assert.equal(new URL(worker.url()).host, extensionId);
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await popup.waitForURL(/#\/lock$/);
  assert.match(await popup.locator("body").innerText(), /vault is locked/i);
  await popup.screenshot({ path: "/tmp/alias-extension-locked.png" });
  await popup.locator('input[type="password"]').fill(bitwardenPassword);
  await popup.getByRole("button", { name: "Unlock", exact: true }).click();
  await popup.waitForURL(/#\/tabs\//, { timeout: 30_000 });
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/tabs/vault`);
  await popup.getByText(marker, { exact: true }).waitFor({ timeout: 20_000 });

  const restartedBrowserStorage = JSON.stringify(
    await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(null, resolve))),
  );
  assert.equal(restartedBrowserStorage.includes(simpleLoginToken), false);

  await permanentlyDeleteBitwardenCipher(bitwardenAuthorization, cipherId);
  await waitForCipherDatabaseState(cipherId, (row) => row === undefined);
  createdCipherId = undefined;

  const bitwardenAccessToken = bitwardenAuthorization?.replace(/^Bearer\s+/i, "");
  const serializedDiagnostics = JSON.stringify(safeDiagnostics);
  assert.equal(serializedDiagnostics.includes(simpleLoginToken), false);
  if (bitwardenAccessToken) {
    assert.equal(serializedDiagnostics.includes(bitwardenAccessToken), false);
  }
  assertServiceLogsDoNotContain(simpleLoginToken);

  console.log("REAL_ALIAS_CREATED", alias.id, aliasAddress);
  console.log("REAL_LOGIN_BOUND", cipherId, marker);
  console.log("REAL_ALIAS_REUSED", alias.id);
  console.log("REAL_EXTENSION_RESTART_UNLOCKED");
  console.log("REAL_STATE_CLEANED");
} finally {
  if (bitwardenAuthorization && createdCipherId) {
    try {
      await permanentlyDeleteBitwardenCipher(bitwardenAuthorization, createdCipherId);
    } catch (error) {
      console.error("BITWARDEN_CLEANUP_FAILED", createdCipherId, error.message);
    }
  }
  await context?.close();
  if (simpleLoginToken && createdAliasId) {
    await deleteSimpleLoginAlias(simpleLoginToken, createdAliasId);
  }
  await Promise.all(servers.map((server) => closeServer(server)));
  fs.rmSync(profile, { recursive: true, force: true });
}

function observeContext(browserContext, apiProxy) {
  browserContext.on("request", (request) => {
    if (request.url().startsWith(simpleLoginUrl.origin)) {
      if (request.method() === "POST" && request.url().includes("/api/alias/random/new")) {
        simpleLoginCreateRequests += 1;
      }
      console.log("SIMPLELOGIN_REQUEST", request.method(), request.url());
    }
    if (request.url().startsWith(apiProxy.url.origin)) {
      bitwardenAuthorization = request.headers().authorization ?? bitwardenAuthorization;
    }
  });
}

function observeWorker(serviceWorker) {
  serviceWorker.on("console", (message) => {
    if (message.type() === "error") {
      recordDiagnostic("WORKER_CONSOLE_ERROR", message.text());
    }
  });
}

function recordDiagnostic(kind, message) {
  let safe = message.replace(/([?&]access_token=)[^&\s"']*/gi, "$1[REDACTED]");
  for (const secret of [simpleLoginToken, bitwardenAuthorization?.replace(/^Bearer\s+/i, "")]) {
    if (secret) {
      safe = safe.split(secret).join("[REDACTED]");
    }
  }
  safeDiagnostics.push(`${kind} ${safe}`);
  console.log(kind, safe);
}

function assertServiceLogsDoNotContain(secret) {
  const logs = spawnSync("docker", ["logs", "alias-core-sl-app"], { encoding: "utf8" });
  assert.equal(logs.status, 0, "SimpleLogin logs must be readable for leakage checks");
  assert.equal(`${logs.stdout}${logs.stderr}`.includes(secret), false);
}

async function permanentlyDeleteBitwardenCipher(authorization, cipherId) {
  const response = await fetch(new URL(`ciphers/${cipherId}`, bitwardenApiUrl), {
    method: "DELETE",
    headers: { authorization },
  });
  await waitForCipherDatabaseState(cipherId, (row) => row === undefined);
  if (!response.ok && response.status !== 400) {
    assert.fail(`Bitwarden delete returned HTTP ${response.status}`);
  }
}

async function createSimpleLoginContact(token, aliasId, contact) {
  const response = await fetch(new URL(`api/aliases/${aliasId}/contacts`, simpleLoginUrl), {
    method: "POST",
    headers: { Authentication: token, "content-type": "application/json" },
    body: JSON.stringify({ contact }),
  });
  assert.equal(response.ok, true);
  return response.json();
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
      device: `bitwarden-browser-e2e-${Date.now()}`,
    }),
  });
  assert.equal(response.ok, true, `SimpleLogin authentication failed (${response.status})`);
  const json = await response.json();
  assert.equal(typeof json.api_key, "string");
  assert.ok(json.api_key.length > 0);
  return json.api_key;
}

async function getSimpleLoginAlias(token, id) {
  const response = await fetch(new URL(`api/aliases/${id}`, simpleLoginUrl), {
    headers: { Authentication: token },
  });
  assert.equal(response.ok, true, `SimpleLogin detail failed (${response.status})`);
  return response.json();
}

async function findSimpleLoginAlias(token, address) {
  const response = await fetch(new URL("api/v2/aliases?page_id=0", simpleLoginUrl), {
    method: "POST",
    headers: { Authentication: token, "content-type": "application/json" },
    body: JSON.stringify({ query: address }),
  });
  assert.equal(response.ok, true, `SimpleLogin search failed (${response.status})`);
  const json = await response.json();
  const alias = json.aliases?.find((candidate) => candidate.email === address);
  assert.ok(alias, `SimpleLogin search must return ${address}`);
  return alias;
}

async function deleteSimpleLoginAlias(token, id) {
  const response = await fetch(new URL(`api/aliases/${id}`, simpleLoginUrl), {
    method: "DELETE",
    headers: { Authentication: token },
  });
  assert.equal(response.ok, true, `SimpleLogin cleanup failed (${response.status})`);
}

async function waitForCipherDatabaseState(cipherId, predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const database = new DatabaseSync(bitwardenDbPath, { readOnly: true });
    const row = database
      .prepare('SELECT "Data", "DeletedDate" FROM "Cipher" WHERE lower("Id") = lower(?)')
      .get(cipherId);
    database.close();
    if (predicate(row)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Cipher database state did not settle for ${cipherId}`);
}

async function startHttpsProxy(target) {
  const server = https.createServer(
    { key: certificate, cert: certificate },
    (request, response) => {
      const upstream = http.request(
        new URL(request.url ?? "/", target),
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

async function startRegistrationServer() {
  const fixture = fs.readFileSync(registrationFixture);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fixture);
  });
  await listen(server);
  return { server, url: new URL(`http://127.0.0.1:${server.address().port}/register`) };
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
