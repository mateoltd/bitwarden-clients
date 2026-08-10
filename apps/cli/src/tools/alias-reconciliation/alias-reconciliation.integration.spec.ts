/** @jest-environment node */

import { execFileSync, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { resolve } from "path";

import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { asUuid } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherData } from "@bitwarden/common/vault/models/data/cipher.data";
import { Cipher } from "@bitwarden/common/vault/models/domain/cipher";
import { CipherRequest } from "@bitwarden/common/vault/models/request/cipher.request";
import { CipherResponse } from "@bitwarden/common/vault/models/response/cipher.response";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import {
  SimpleLoginAliasService,
  SimpleLoginAliasTransport,
} from "@bitwarden/generator-core";
import { ClientSettings, PasswordManagerClient, TokenProvider } from "@bitwarden/sdk-internal";

import { AliasReconciliationService } from "./alias-reconciliation.service";

const integrationEnabled =
  process.env["ALIAS_MIGRATION_INTEGRATION"] === "1" &&
  process.env["SIMPLELOGIN_INTEGRATION"] === "1" &&
  process.env["BITWARDEN_SERVER_INTEGRATION"] === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;
const fixtureSize = Number(process.env["ALIAS_MIGRATION_FIXTURE_SIZE"] ?? "1001");

const bitwardenSettings: ClientSettings = {
  apiUrl: process.env["BITWARDEN_API_URL"] ?? "http://localhost:4000",
  identityUrl: process.env["BITWARDEN_IDENTITY_URL"] ?? "http://localhost:33656",
  userAgent: "Bitwarden alias migration integration test",
  deviceType: "SDK",
  bitwardenClientVersion: "2026.7.2",
};

const bitwardenDatabaseCandidates = [
  resolve(process.cwd(), "../.integration-labs/first-class-aliases/bitwarden-server/dev/db/bitwarden.db"),
  resolve(
    process.cwd(),
    "../../../.integration-labs/first-class-aliases/bitwarden-server/dev/db/bitwarden.db",
  ),
];
const bitwardenDatabase =
  process.env["BITWARDEN_SQLITE_PATH"] ??
  bitwardenDatabaseCandidates.find((candidate) => existsSync(candidate)) ??
  bitwardenDatabaseCandidates[0];

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
        deviceName: "Alias migration integration test",
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
      "alias-core-sl-db",
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
  return execFileSync("sqlite3", [bitwardenDatabase, sql], { encoding: "utf8" }).trim();
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

describeIntegration("real 1,000+ alias migration", () => {
  jest.setTimeout(900_000);

  const simpleLoginBaseUrl = process.env["SIMPLELOGIN_BASE_URL"] ?? "http://127.0.0.1:32769";
  const simpleLoginEmail = process.env["SIMPLELOGIN_EMAIL"] ?? "john@wick.com";
  const simpleLoginPassword = process.env["SIMPLELOGIN_PASSWORD"] ?? "password";
  const bitwardenEmail = process.env["BITWARDEN_EMAIL"] ?? "alias.lab@individual.example";
  const bitwardenPassword = process.env["BITWARDEN_PASSWORD"] ?? "alias-lab-password";

  it("dry-runs, applies and idempotently verifies 1,001 persisted aliases and logins", async () => {
    const marker = `bwmig${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const addressPrefix = `${marker}-`;
    const api = { nativeFetch: (request: Request) => fetch(request) } as ApiService;
    let providerToken = "";
    let firstClient: AuthenticatedClient | undefined;
    let secondClient: AuthenticatedClient | undefined;
    let cipherIds: string[] = [];

    try {
      simpleLoginSql(`
        INSERT INTO alias
          (created_at, user_id, email, enabled, automatic_creation, mailbox_id,
           disable_pgp, cannot_be_disabled, disable_email_spoofing_check, pinned)
        SELECT CURRENT_TIMESTAMP + (series * INTERVAL '1 microsecond'),
               1, '${addressPrefix}' || series || '@sl.lan', TRUE, FALSE, 1,
               FALSE, FALSE, FALSE, FALSE
        FROM generate_series(0, ${fixtureSize - 1}) AS series;
      `);
      expect(
        Number(
          simpleLoginSql(
            `SELECT COUNT(*) FROM alias WHERE email LIKE '${addressPrefix}%@sl.lan';`,
          ),
        ),
      ).toBe(fixtureSize);

      const simpleLoginLogin = await fetch(`${simpleLoginBaseUrl}/api/auth/login`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          email: simpleLoginEmail,
          password: simpleLoginPassword,
          device: "Bitwarden alias migration integration test",
        }),
      });
      const loginBody = (await simpleLoginLogin.json()) as { api_key?: unknown };
      if (!simpleLoginLogin.ok || typeof loginBody.api_key !== "string") {
        throw new Error(`SimpleLogin test login failed (${simpleLoginLogin.status})`);
      }
      providerToken = loginBody.api_key;
      const aliasService = new SimpleLoginAliasService(new SimpleLoginAliasTransport(api), {
        token: providerToken,
        baseUrl: simpleLoginBaseUrl,
      });

      firstClient = await authenticateBitwardenClient(bitwardenEmail, bitwardenPassword);
      const importCiphers: CipherRequest[] = [];
      for (let index = 0; index < fixtureSize; index++) {
        const view = new CipherView();
        view.type = CipherType.Login;
        view.name = `${marker} login ${index}`;
        view.login.username = `${addressPrefix}${index}@sl.lan`;
        view.login.password = "migration-fixture-password";
        const encrypted = await firstClient.client.vault().ciphers().encrypt(view.toSdkCipherView());
        importCiphers.push(
          new CipherRequest({
            cipher: Cipher.fromSdkCipher(encrypted.cipher)!,
            encryptedFor: firstClient.userId,
          }),
        );
      }

      const serializedImport = JSON.stringify({
        folders: [],
        ciphers: importCiphers,
        folderRelationships: [],
      });
      expect(serializedImport).not.toContain(addressPrefix);
      expect(serializedImport).not.toContain(providerToken);
      const imported = await vaultRequest(firstClient.accessToken, "/ciphers/import", {
        method: "POST",
        body: serializedImport,
      });
      expect(imported.response.status).toBe(200);

      const initialSync = await vaultRequest(firstClient.accessToken, "/sync?excludeDomains=true");
      expect(initialSync.response.status).toBe(200);
      expect(initialSync.text).not.toContain(addressPrefix);
      expect(initialSync.text).not.toContain(providerToken);
      const rawCiphers = (initialSync.json?.Ciphers ?? initialSync.json?.ciphers) as unknown[];
      const decrypted = await decryptCiphers(firstClient, rawCiphers);
      const fixtureCiphers = decrypted.filter((cipher) =>
        cipher.login?.username?.startsWith(addressPrefix),
      );
      expect(fixtureCiphers).toHaveLength(fixtureSize);
      cipherIds = fixtureCiphers.map((cipher) => cipher.id!);

      const quotedIds = cipherIds.map((id) => `'${id}'`).join(",");
      expect(Number(sqlite(`SELECT COUNT(*) FROM Cipher WHERE LOWER(Id) IN (${quotedIds});`))).toBe(
        fixtureSize,
      );

      const realVaultAdapter = {
        getAllDecrypted: async () => fixtureCiphers,
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
        unbound: fixtureSize,
        plannedChanges: fixtureSize,
        appliedChanges: 0,
      });
      expect(JSON.stringify(dryRun)).not.toContain(providerToken);

      const applied = await reconciliation.reconcile(firstClient.userId, true);
      expect(applied.summary).toMatchObject({
        loginCiphersScanned: fixtureSize,
        exactMatches: fixtureSize,
        unbound: 0,
        plannedChanges: fixtureSize,
        appliedChanges: fixtureSize,
        failedChanges: 0,
      });
      expect(JSON.stringify(applied)).not.toContain(providerToken);

      const idempotentRerun = await reconciliation.reconcile(firstClient.userId, true);
      expect(idempotentRerun.summary).toMatchObject({
        exactMatches: fixtureSize,
        unbound: 0,
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
      const finalViews = (await decryptCiphers(secondClient, finalRawCiphers)).filter((cipher) =>
        cipher.login?.username?.startsWith(addressPrefix),
      );
      expect(finalViews).toHaveLength(fixtureSize);
      expect(finalViews.every((cipher) => cipher.aliasBinding?.address === cipher.login.username)).toBe(
        true,
      );
      expect(finalViews.every((cipher) => (cipher.fields ?? []).length === 0)).toBe(true);

      const persistedVaultData = sqlite(
        `SELECT GROUP_CONCAT(Data, '') FROM Cipher WHERE LOWER(Id) IN (${quotedIds});`,
      );
      expect(persistedVaultData).not.toContain(addressPrefix);
      expect(persistedVaultData).not.toContain(providerToken);
      const simpleLoginLogResult = spawnSync("docker", ["logs", "alias-core-sl-app"], {
        encoding: "utf8",
      });
      expect(simpleLoginLogResult.status).toBe(0);
      const simpleLoginLogs = `${simpleLoginLogResult.stdout}${simpleLoginLogResult.stderr}`;
      expect(simpleLoginLogs).not.toContain(providerToken);
    } finally {
      if (cipherIds.length > 0 && (secondClient || firstClient)) {
        const authenticated = secondClient ?? firstClient!;
        await vaultRequest(authenticated.accessToken, "/ciphers", {
          method: "DELETE",
          body: JSON.stringify({ ids: cipherIds }),
        }).catch((): void => undefined);
      }
      simpleLoginSql(`DELETE FROM alias WHERE email LIKE '${addressPrefix}%@sl.lan';`);
      firstClient?.client.free();
      secondClient?.client.free();
    }

    expect(
      Number(
        simpleLoginSql(`SELECT COUNT(*) FROM alias WHERE email LIKE '${addressPrefix}%@sl.lan';`),
      ),
    ).toBe(0);
    if (cipherIds.length > 0) {
      const quotedIds = cipherIds.map((id) => `'${id}'`).join(",");
      expect(Number(sqlite(`SELECT COUNT(*) FROM Cipher WHERE LOWER(Id) IN (${quotedIds});`))).toBe(
        0,
      );
    }
  });
});
