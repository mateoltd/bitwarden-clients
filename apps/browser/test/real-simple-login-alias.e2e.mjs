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
  process.env.BROWSER_EXTENSION_DIRECTORY ?? "dist/apps/browser/chrome-dev",
);
const registrationFixture = path.resolve(root, "apps/browser/test/alias-registration.html");
const certificate = fs.readFileSync(path.resolve(root, "apps/web/dev-server.shared.pem"));
const browserExecutable = process.env.CHROMIUM_PATH ?? chromium.executablePath();

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
  const apiProxy = await startHttpsProxy(bitwardenApiBaseUrl);
  const identityProxy = await startHttpsProxy(bitwardenIdentityBaseUrl);
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
      "--ignore-certificate-errors",
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
      `--host-resolver-rules=MAP ${registrationHostname} 127.0.0.1`,
    ],
  };
  context = await chromium.launchPersistentContext(profile, launchOptions);
  context.setDefaultTimeout(15_000);
  observeContext(context, apiProxy);

  worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  observeWorker(worker);
  extensionId = new URL(worker.url()).host;
  popup = await context.newPage();

  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  const clickOnboardingButton = (label) =>
    popup.evaluate((exactLabel) => {
      const button = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === exactLabel,
      );
      if (!(button instanceof HTMLButtonElement)) {
        return false;
      }
      button.click();
      return true;
    }, label);
  for (let step = 0; step < 8 && !(await popup.locator("#email").isVisible()); step++) {
    // Fresh-install state can replace either prompt while Chrome's default-manager check settles.
    // Resolve and click in one page evaluation so a detached locator cannot consume the timeout.
    const progressed =
      (await clickOnboardingButton("Skip")) || (await clickOnboardingButton("Log in"));
    await popup.waitForTimeout(progressed ? 250 : 500);
  }
  try {
    await popup.locator("#email").waitFor({ timeout: 30_000 });
  } catch (error) {
    await popup.screenshot({ path: "/tmp/alias-extension-login-unavailable.png" });
    recordDiagnostic(
      "LOGIN_SCREEN_UNAVAILABLE",
      `${popup.url()} ${(await popup.locator("body").innerText()).slice(0, 500)}`,
    );
    throw error;
  }
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
  const menuContainerFrame = registration
    .frames()
    .find((frame) => frame.url().includes("/overlay/menu.html"));
  assert.ok(menuContainerFrame, "the extension menu container must be injected");
  await registration.locator("#email").press("ArrowDown");
  const hostileAttacks = await attemptHostileAliasMessages(registration);
  await registration.screenshot({ path: "/tmp/alias-registration.png" });
  const hostileReplay = hostileAttacks.replay;
  assert.ok(
    hostileReplay.frameCount > 0,
    `the hostile page must target an injected extension frame: ${JSON.stringify(hostileReplay)}`,
  );
  assert.ok(
    hostileReplay.observedCount > 0,
    `the hostile page must replay observed session material: ${JSON.stringify(hostileReplay)}`,
  );
  await registration.waitForTimeout(750);
  assert.equal(await registration.locator("#email").inputValue(), "");
  assert.equal(simpleLoginCreateRequests, 0, "host-parent replay must not mutate the provider");
  const confusedDeputy = hostileAttacks.confusedDeputy;
  assert.ok(
    confusedDeputy.frameCount > 0,
    "the hostile page must target an injected extension frame for the deputy attempt",
  );
  await registration.waitForTimeout(750);
  assert.equal(await registration.locator("#email").inputValue(), "");
  assert.equal(
    simpleLoginCreateRequests,
    0,
    "confused-deputy messages must not mutate the provider",
  );
  await registration.goto(registrationUrl.toString());
  await registration.locator("#email").focus();
  await registration.waitForTimeout(1_500);
  assert.ok(
    registration.frames().some((frame) => frame.url().includes("/overlay/menu.html")),
    "the extension menu container must be reinjected after hostile-message isolation",
  );
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
  await registration.bringToFront();
  await registration.locator("#password").fill(loginPassword);
  let saveLoginFrame;
  const saveLoginDeadline = Date.now() + 15_000;
  while (!saveLoginFrame && Date.now() < saveLoginDeadline) {
    await registration.locator("#email").focus();
    await registration.waitForTimeout(100);
    await registration.locator("#password").focus();
    await registration.waitForTimeout(250);
    await registration.locator("#password").press("ArrowDown");
    await registration.waitForTimeout(250);
    for (const frame of registration
      .frames()
      .filter((candidate) => candidate.url().includes("/overlay/menu-list.html"))) {
      if (
        await frame
          .locator(".save-login")
          .isVisible()
          .catch(() => false)
      ) {
        saveLoginFrame = frame;
        break;
      }
    }
  }
  assert.ok(saveLoginFrame, "the save-login inline menu must be visible");
  await registration.screenshot({ path: "/tmp/alias-registration-save.png" });
  const addEditPagePromise = context.waitForEvent("page");
  await saveLoginFrame.locator(".save-login").click();
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
  const persistedCipher = readCipher(database, cipherId, false);
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
  const deleteContactDialog = popup.getByRole("dialog");
  await deleteContactDialog.waitFor();
  await deleteContactDialog.getByRole("button", { name: "Delete", exact: true }).click();
  assert.equal((await deleteContactResponse).ok(), true);
  await popup.getByText(reverseContact, { exact: true }).waitFor({ state: "detached" });

  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/account-switcher`);
  await popup.getByRole("button", { name: "Lock now", exact: true }).click();
  await context.close().catch(() => undefined);
  context = await chromium.launchPersistentContext(profile, launchOptions);
  context.setDefaultTimeout(15_000);
  observeContext(context, apiProxy);
  worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
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
  const restartedVaultItem = popup
    .getByText(marker, { exact: true })
    .locator("xpath=ancestor::bit-item");
  await restartedVaultItem.getByRole("button", { name: "More options" }).click();
  await popup.getByRole("menuitem", { name: "Manage bound alias", exact: true }).click();
  await popup.waitForURL(new RegExp(`#\/email-aliases\/${alias.id}$`));
  await popup.getByTestId("alias-address").filter({ hasText: aliasAddress }).waitFor();

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

  console.log("REAL_ALIAS_CREATED_WITH_STABLE_ID");
  console.log("HOSTILE_PARENT_REPLAY_REJECTED");
  console.log("CONFUSED_DEPUTY_REJECTED");
  console.log("REAL_LOGIN_BOUND_AND_ENCRYPTED");
  console.log("REAL_ALIAS_REUSED");
  console.log("REAL_EXTENSION_RESTART_UNLOCKED");
  console.log("REAL_STATE_CLEANED");
} finally {
  if (bitwardenAuthorization && createdCipherId) {
    try {
      await permanentlyDeleteBitwardenCipher(bitwardenAuthorization, createdCipherId);
    } catch (error) {
      recordDiagnostic(
        "BITWARDEN_CLEANUP_FAILED",
        error instanceof Error ? error.message : "error",
      );
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
  browserContext.on("requestfailed", (request) => {
    if (request.url().startsWith(apiProxy.url.origin)) {
      recordDiagnostic(
        "BITWARDEN_REQUEST_FAILED",
        `${request.method()} ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? "unknown"}`,
      );
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

async function attemptHostileAliasMessages(page) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const frame = page
      .frames()
      .find((candidate) => candidate.url().includes("/overlay/menu-list.html"));
    if (frame) {
      try {
        const session = await frame.evaluate(() => {
          const list = document.querySelector("autofill-inline-menu-list");
          const portKey = list?.portKey;
          const token = list?.token;
          return typeof portKey === "string" && typeof token === "string"
            ? { portKey, token }
            : undefined;
        });
        const containerFrame = frame.parentFrame();
        if (!session || !containerFrame) {
          await page.waitForTimeout(50);
          continue;
        }
        const containerElement = await containerFrame.frameElement();
        try {
          return await containerElement.evaluate((iframe, observedSession) => {
            const target = iframe.contentWindow;
            if (!target) {
              throw new Error("the injected alias container has no content window");
            }
            target.postMessage(
              {
                command: "fillEmailAlias",
                ...observedSession,
                emailAliasFillCapability: "a".repeat(32),
              },
              "*",
            );
            target.postMessage(
              {
                command: "updateAutofillInlineMenuEmailAliasRecommendation",
                ...observedSession,
                emailAliasRecommendation: {
                  hostname: location.hostname,
                  canCreate: true,
                },
              },
              "*",
            );
            target.postMessage({ command: "fillEmailAlias", ...observedSession }, "*");
            return {
              replay: { frameCount: 1, observedCount: 1 },
              confusedDeputy: { frameCount: 1, observedCount: 1 },
            };
          }, session);
        } finally {
          await containerElement.dispose();
        }
      } catch {
        // The button-to-list transition can detach a frame between discovery and evaluation.
      }
    }
    await page.waitForTimeout(50);
  }
  throw new Error("the rendered alias list could not receive hostile parent messages");
}

function recordDiagnostic(kind, message) {
  let safe = String(message)
    .replace(/([?&]access_token(?:%3[dD]|=))[^&\s"']*/gi, "$1[REDACTED]")
    .replace(
      /\b(authorization|authentication)(\s*[:=]\s*)(?:bearer\s+)?[^,;\s"']+/gi,
      "$1$2[REDACTED]",
    );
  for (const secret of [simpleLoginToken, bitwardenAuthorization?.replace(/^Bearer\s+/i, "")]) {
    if (secret) {
      safe = safe.split(secret).join("[REDACTED]");
    }
  }
  safe = safe.slice(0, 1_000);
  safeDiagnostics.push(`${kind} ${safe}`);
  console.log(kind, safe);
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

async function permanentlyDeleteBitwardenCipher(authorization, cipherId) {
  const response = await fetch(new URL(`ciphers/${cipherId}`, bitwardenApiBaseUrl), {
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
    const row = readCipher(database, cipherId, true);
    database.close();
    if (predicate(row)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Cipher database state did not settle for ${cipherId}`);
}

function readCipher(database, cipherId, includeDeletedDate) {
  if (process.env.BITWARDEN_DB_DIALECT === "vaultwarden") {
    const columns = includeDeletedDate
      ? 'data AS "Data", deleted_at AS "DeletedDate"'
      : 'data AS "Data"';
    return database
      .prepare(`SELECT ${columns} FROM ciphers WHERE lower(uuid) = lower(?)`)
      .get(cipherId);
  }
  const columns = includeDeletedDate ? '"Data", "DeletedDate"' : '"Data"';
  return database
    .prepare(`SELECT ${columns} FROM "Cipher" WHERE lower("Id") = lower(?)`)
    .get(cipherId);
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
          if ((upstreamResponse.statusCode ?? 500) >= 400) {
            recordDiagnostic(
              "BITWARDEN_PROXY_RESPONSE",
              `${request.method} ${request.url ?? "/"} ${upstreamResponse.statusCode ?? 502}`,
            );
          }
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", (error) => {
        recordDiagnostic("BITWARDEN_PROXY_ERROR", error.message);
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
