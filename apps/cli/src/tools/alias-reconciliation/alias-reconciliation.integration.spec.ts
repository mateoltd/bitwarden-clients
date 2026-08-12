/** @jest-environment node */

import { execFileSync } from "child_process";
import { randomUUID } from "crypto";

import { asUuid } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherData } from "@bitwarden/common/vault/models/data/cipher.data";
import { Cipher } from "@bitwarden/common/vault/models/domain/cipher";
import { CipherRequest } from "@bitwarden/common/vault/models/request/cipher.request";
import { CipherResponse } from "@bitwarden/common/vault/models/response/cipher.response";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { createSimpleLoginAliasService } from "@bitwarden/generator-core";
import { ClientSettings, PasswordManagerClient, TokenProvider } from "@bitwarden/sdk-internal";

import { AliasReconciliationService } from "./alias-reconciliation.service";

const integrationEnabled =
  process.env["ALIAS_RECONCILIATION_INTEGRATION"] === "1" &&
  process.env["SIMPLELOGIN_INTEGRATION"] === "1" &&
  process.env["BITWARDEN_SERVER_INTEGRATION"] === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;
const fixtureSize = Number(process.env["ALIAS_RECONCILIATION_FIXTURE_SIZE"] ?? "1001");
const fixtureMarkerPrefix = "bwrec";

const bitwardenSettings: ClientSettings = {
  apiUrl: process.env["BITWARDEN_API_URL"] ?? "http://localhost:4000",
  identityUrl: process.env["BITWARDEN_IDENTITY_URL"] ?? "http://localhost:33656",
  userAgent: "Bitwarden alias reconciliation integration test",
  deviceType: "SDK",
  bitwardenClientVersion: "2026.7.2",
};

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for alias reconciliation integration tests`);
  }
  return value;
}

class MutableTokenProvider implements TokenProvider {
  token?: string;

  async get_access_token(): Promise<string | undefined> {
    return this.token;
  }
}

type AuthenticatedClient = {
  client: PasswordManagerClient;
  accessToken: string;
  userId: UserId;
};

function userIdFromAccessToken(accessToken: string): UserId {
  const payload = accessToken.split(".")[1];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    sub?: unknown;
  };
  if (typeof claims.sub !== "string") {
    throw new Error("Bitwarden access token has no user subject");
  }
  return claims.sub as UserId;
}

async function authenticateBitwardenClient(
  email: string,
  password: string,
): Promise<AuthenticatedClient> {
  const tokenProvider = new MutableTokenProvider();
  const client = new PasswordManagerClient(tokenProvider, bitwardenSettings);
  const loginClient = client.auth().login(bitwardenSettings);
  const prelogin = await loginClient.get_password_prelogin(email);
  const response = await loginClient.login_via_password({
    loginRequest: {
      clientId: "connector",
      device: {
        deviceType: "SDK",
        deviceIdentifier: randomUUID(),
        deviceName: "Alias reconciliation integration test",
        devicePushToken: undefined,
      },
    },
    email,
    password,
    preloginResponse: prelogin,
  });
  const login = response.Authenticated;
  const userId = userIdFromAccessToken(login.accessToken);
  const unlock = login.userDecryptionOptions.masterPasswordUnlock;
  if (!login.wrappedAccountCryptoState || !unlock) {
    client.free();
    throw new Error("Bitwarden login did not return master-password crypto state");
  }

  tokenProvider.token = login.accessToken;
  await client.crypto().initialize_user_crypto({
    userId: asUuid(userId),
    email,
    kdfParams: prelogin.kdf,
    accountCryptographicState: login.wrappedAccountCryptoState,
    method: { masterPasswordUnlock: { password, master_password_unlock: unlock } },
  });
  await client.crypto().initialize_org_crypto({ organizationKeys: new Map() });
  return { client, accessToken: login.accessToken, userId };
}

async function vaultRequest(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; text: string; json?: any }> {
  const response = await fetch(`${bitwardenSettings.apiUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const text = await response.text();
  return { response, text, json: text ? JSON.parse(text) : undefined };
}

function simpleLoginSql(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      process.env["SIMPLELOGIN_DB_CONTAINER"] ?? "alias-core-sl-db",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-qAt",
      "-U",
      "simplelogin",
      "-d",
      "simplelogin",
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  ).trim();
}

function sqlite(sql: string): string {
  return execFileSync("sqlite3", [requiredEnvironmentVariable("BITWARDEN_SQLITE_PATH"), sql], {
    encoding: "utf8",
  }).trim();
}

async function runInBatches<Input, Output>(
  values: Input[],
  operation: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const outputs: Output[] = [];
  for (let offset = 0; offset < values.length; offset += 20) {
    outputs.push(...(await Promise.all(values.slice(offset, offset + 20).map(operation))));
  }
  return outputs;
}

async function deleteCiphers(accessToken: string, cipherIds: string[]): Promise<void> {
  for (let offset = 0; offset < cipherIds.length; offset += 250) {
    const ids = cipherIds.slice(offset, offset + 250);
    const deleted = await vaultRequest(accessToken, "/ciphers", {
      method: "DELETE",
      body: JSON.stringify({ ids }),
    });
    if (!deleted.response.ok) {
      throw new Error(`Bitwarden bulk cipher deletion failed (${deleted.response.status})`);
    }
  }
}

function persistedCipherCount(cipherIds: string[]): number {
  if (cipherIds.length === 0) {
    return 0;
  }
  if (cipherIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
    throw new Error("Bitwarden returned an invalid cipher id");
  }
  const quotedIds = cipherIds.map((id) => `'${id.toLowerCase()}'`).join(",");
  return Number(sqlite(`SELECT COUNT(*) FROM Cipher WHERE LOWER(Id) IN (${quotedIds});`));
}

async function decryptCiphers(
  authenticated: AuthenticatedClient,
  rawCiphers: unknown[],
): Promise<CipherView[]> {
  const result: CipherView[] = [];
  for (const rawCipher of rawCiphers) {
    const cipher = new Cipher(new CipherData(new CipherResponse(rawCipher)));
    const decrypted = await authenticated.client.vault().ciphers().decrypt(cipher.toSdkCipher());
    const view = CipherView.fromSdkCipherView(decrypted);
    if (view) {
      result.push(view);
    }
  }
  return result;
}

describeIntegration("real current-schema alias reconciliation", () => {
  jest.setTimeout(900_000);

  const simpleLoginBaseUrl = process.env["SIMPLELOGIN_BASE_URL"] ?? "http://127.0.0.1:32769";

  it("reconciles and verifies 1,001+ canonical bindings after real provider drift", async () => {
    if (!Number.isSafeInteger(fixtureSize) || fixtureSize < 1_001) {
      throw new Error("ALIAS_RECONCILIATION_FIXTURE_SIZE must be an integer of at least 1001");
    }
    const simpleLoginEmail = requiredEnvironmentVariable("SIMPLELOGIN_EMAIL");
    const simpleLoginPassword = requiredEnvironmentVariable("SIMPLELOGIN_PASSWORD");
    const bitwardenEmail = requiredEnvironmentVariable("BITWARDEN_EMAIL");
    const bitwardenPassword = requiredEnvironmentVariable("BITWARDEN_PASSWORD");
    const marker = `${fixtureMarkerPrefix}${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const addressPrefix = `${marker}-`;
    const connectionId = randomUUID();
    let providerToken = "";
    let firstClient: AuthenticatedClient | undefined;
    let secondClient: AuthenticatedClient | undefined;
    const cipherIds: string[] = [];

    try {
      const simpleLoginLogin = await fetch(`${simpleLoginBaseUrl}/api/auth/login`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          email: simpleLoginEmail,
          password: simpleLoginPassword,
          device: "Bitwarden alias reconciliation integration test",
        }),
      });
      const loginBody = (await simpleLoginLogin.json()) as { api_key?: unknown };
      if (!simpleLoginLogin.ok || typeof loginBody.api_key !== "string") {
        throw new Error(`SimpleLogin test login failed (${simpleLoginLogin.status})`);
      }
      providerToken = loginBody.api_key;
      const aliasService = createSimpleLoginAliasService({
        token: providerToken,
        baseUrl: simpleLoginBaseUrl,
        connectionId,
      });
      const provider = aliasService.providerIdentity();

      firstClient = await authenticateBitwardenClient(bitwardenEmail, bitwardenPassword);
      const existingSync = await vaultRequest(firstClient.accessToken, "/sync?excludeDomains=true");
      expect(existingSync.response.status).toBe(200);
      const existingRaw = (existingSync.json?.Ciphers ?? existingSync.json?.ciphers) as unknown[];
      const existingViews = await decryptCiphers(firstClient, existingRaw);
      const residualFixtures = existingViews.filter((cipher) =>
        /^bwrec\d+ login \d+$/.test(cipher.name ?? ""),
      );
      if (residualFixtures.length > 0) {
        const residualMarkers = new Set(
          residualFixtures.map((cipher) => cipher.name!.slice(0, cipher.name!.indexOf(" login "))),
        );
        throw new Error(
          `Residual alias reconciliation fixtures: ${[...residualMarkers].join(", ")}`,
        );
      }
      expect(
        Number(
          simpleLoginSql(
            `SELECT COUNT(*) FROM alias WHERE email LIKE '${fixtureMarkerPrefix}%@alias.example';`,
          ),
        ),
      ).toBe(0);

      simpleLoginSql(`
        INSERT INTO alias
          (created_at, user_id, email, enabled, automatic_creation, mailbox_id,
           disable_pgp, cannot_be_disabled, disable_email_spoofing_check, pinned)
        SELECT CURRENT_TIMESTAMP + (series * INTERVAL '1 microsecond'),
               1, '${addressPrefix}' || series || '@alias.example', TRUE, FALSE, 1,
               FALSE, FALSE, FALSE, FALSE
        FROM generate_series(0, ${fixtureSize - 1}) AS series;
      `);
      const aliasRows = simpleLoginSql(`
        SELECT id || '|' || email
        FROM alias
        WHERE email LIKE '${addressPrefix}%@alias.example'
        ORDER BY id;
      `)
        .split("\n")
        .filter(Boolean)
        .map((row) => {
          const separator = row.indexOf("|");
          return { id: row.slice(0, separator), address: row.slice(separator + 1) };
        });
      expect(aliasRows).toHaveLength(fixtureSize);
      const expectedAliasIds = new Set(aliasRows.map((alias) => alias.id));

      const serializedCreateRequests: string[] = [];
      for (let index = 0; index < aliasRows.length; index++) {
        const alias = aliasRows[index];
        const view = new CipherView();
        view.type = CipherType.Login;
        view.name = `${marker} login ${index}`;
        view.login.username = alias.address;
        view.login.password = "account-password";
        view.aliasBinding = {
          version: 2,
          provider: provider.provider,
          providerInstance: provider.instance,
          connectionId,
          aliasId: alias.id,
          address: alias.address,
        };
        const encrypted = await firstClient.client
          .vault()
          .ciphers()
          .encrypt(view.toSdkCipherView());
        const createRequest = new CipherRequest({
          cipher: Cipher.fromSdkCipher(encrypted.cipher)!,
          encryptedFor: firstClient.userId,
        });
        const serialized = JSON.stringify(createRequest);
        expect(serialized).not.toContain(addressPrefix);
        expect(serialized).not.toContain(providerToken);
        serializedCreateRequests.push(serialized);
      }

      const createResults = await runInBatches(serializedCreateRequests, (body) =>
        vaultRequest(firstClient!.accessToken, "/ciphers", { method: "POST", body }),
      );
      for (const created of createResults) {
        if (created.response.ok) {
          cipherIds.push(new CipherResponse(created.json).id);
        }
      }
      expect(createResults.every((created) => created.response.status === 200)).toBe(true);
      expect(cipherIds).toHaveLength(fixtureSize);

      const driftedAlias = aliasRows[0];
      const refreshedAddress = `${addressPrefix}refreshed@alias.example`;
      simpleLoginSql(
        `UPDATE alias SET email = '${refreshedAddress}' WHERE id = ${driftedAlias.id};`,
      );
      const cipherIdSet = new Set(cipherIds);

      const realVaultAdapter = {
        getAllDecrypted: async () => {
          const sync = await vaultRequest(firstClient!.accessToken, "/sync?excludeDomains=true");
          if (sync.response.status !== 200) {
            throw new Error(`Bitwarden sync failed (${sync.response.status})`);
          }
          const raw = (sync.json?.Ciphers ?? sync.json?.ciphers) as unknown[];
          return (await decryptCiphers(firstClient!, raw)).filter(
            (cipher) => cipher.id !== undefined && cipherIdSet.has(cipher.id),
          );
        },
        updateWithServer: async (view: CipherView) => {
          const encrypted = await firstClient!.client
            .vault()
            .ciphers()
            .encrypt(view.toSdkCipherView());
          const request = new CipherRequest({
            cipher: Cipher.fromSdkCipher(encrypted.cipher)!,
            encryptedFor: firstClient!.userId,
          });
          const serialized = JSON.stringify(request);
          if (serialized.includes(view.login.username) || serialized.includes(providerToken)) {
            throw new Error("Alias update included plaintext alias data or provider credentials");
          }
          const updated = await vaultRequest(firstClient!.accessToken, `/ciphers/${view.id}`, {
            method: "PUT",
            body: serialized,
          });
          if (updated.response.status !== 200) {
            throw new Error(`Bitwarden cipher update failed (${updated.response.status})`);
          }
          return view;
        },
      };
      const reconciliation = new AliasReconciliationService(aliasService, realVaultAdapter);

      const dryRun = await reconciliation.reconcile(firstClient.userId, false);
      expect(dryRun.summary).toMatchObject({
        loginCiphersScanned: fixtureSize,
        exactMatches: fixtureSize - 1,
        conflicts: 1,
        plannedChanges: 1,
        appliedChanges: 0,
      });
      expect(JSON.stringify(dryRun)).not.toContain(providerToken);

      const applied = await reconciliation.reconcile(firstClient.userId, true);
      expect(applied.summary).toMatchObject({
        loginCiphersScanned: fixtureSize,
        exactMatches: fixtureSize,
        conflicts: 0,
        plannedChanges: 1,
        appliedChanges: 1,
        failedChanges: 0,
      });
      expect(new Set(applied.exactMatches.map((match) => match.alias.aliasId))).toEqual(
        expectedAliasIds,
      );
      expect(JSON.stringify(applied)).not.toContain(providerToken);

      const idempotentRerun = await reconciliation.reconcile(firstClient.userId, true);
      expect(idempotentRerun.summary).toMatchObject({
        exactMatches: fixtureSize,
        conflicts: 0,
        plannedChanges: 0,
        appliedChanges: 0,
        failedChanges: 0,
      });

      secondClient = await authenticateBitwardenClient(bitwardenEmail, bitwardenPassword);
      const finalSync = await vaultRequest(secondClient.accessToken, "/sync?excludeDomains=true");
      expect(finalSync.response.status).toBe(200);
      expect(finalSync.text).not.toContain(addressPrefix);
      expect(finalSync.text).not.toContain(providerToken);
      const finalRawCiphers = (finalSync.json?.Ciphers ?? finalSync.json?.ciphers) as unknown[];
      const finalViews = (await decryptCiphers(secondClient, finalRawCiphers)).filter(
        (cipher) => cipher.id !== undefined && cipherIdSet.has(cipher.id),
      );
      expect(finalViews).toHaveLength(fixtureSize);
      expect(new Set(finalViews.map((cipher) => cipher.aliasBinding?.aliasId))).toEqual(
        expectedAliasIds,
      );
      expect(finalViews.every((cipher) => cipher.aliasBinding?.version === 2)).toBe(true);
      expect(finalViews.every((cipher) => cipher.fields?.length === 0)).toBe(true);
      const refreshedView = finalViews.find(
        (cipher) => cipher.aliasBinding?.aliasId === driftedAlias.id,
      );
      expect(refreshedView?.login.username).toBe(refreshedAddress);
      expect(refreshedView?.aliasBinding).toMatchObject({
        version: 2,
        connectionId,
        aliasId: driftedAlias.id,
        address: refreshedAddress,
      });
    } finally {
      if (cipherIds.length > 0 && (secondClient || firstClient)) {
        const authenticated = secondClient ?? firstClient!;
        await deleteCiphers(authenticated.accessToken, cipherIds);
      }
      simpleLoginSql(`DELETE FROM alias WHERE email LIKE '${addressPrefix}%@alias.example';`);
      expect(persistedCipherCount(cipherIds)).toBe(0);
      expect(
        Number(
          simpleLoginSql(
            `SELECT COUNT(*) FROM alias WHERE email LIKE '${addressPrefix}%@alias.example';`,
          ),
        ),
      ).toBe(0);
      firstClient?.client.free();
      secondClient?.client.free();
    }
  });
});
