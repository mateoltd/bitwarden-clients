/** @jest-environment node */

import { randomUUID } from "crypto";

import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { asUuid } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import { UserId } from "@bitwarden/common/types/guid";
import { bindGeneratedAlias } from "@bitwarden/common/vault/alias-binding";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherData } from "@bitwarden/common/vault/models/data/cipher.data";
import { Cipher } from "@bitwarden/common/vault/models/domain/cipher";
import { CipherRequest } from "@bitwarden/common/vault/models/request/cipher.request";
import { CipherResponse } from "@bitwarden/common/vault/models/response/cipher.response";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { ClientSettings, PasswordManagerClient, TokenProvider } from "@bitwarden/sdk-internal";

import { SimpleLoginForwarder } from "../engine/simple-login-forwarder";
import { SimpleLogin } from "../integration/simple-login";
import { GeneratedCredential } from "../types";

import { createSimpleLoginAliasService } from "./simple-login-alias.service";

const integrationEnabled =
  process.env["SIMPLELOGIN_INTEGRATION"] === "1" &&
  process.env["BITWARDEN_SERVER_INTEGRATION"] === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;

function requiredIntegrationSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for alias integration tests`);
  }
  return value;
}

const bitwardenSettings: ClientSettings = {
  apiUrl: process.env["BITWARDEN_API_URL"] ?? "http://localhost:4000",
  identityUrl: process.env["BITWARDEN_IDENTITY_URL"] ?? "http://localhost:33656",
  userAgent: "Bitwarden clients alias integration test",
  deviceType: "SDK",
  bitwardenClientVersion: "2026.7.2",
};

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
        deviceName: "Alias integration test",
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
  let json: any;
  if (text) {
    json = JSON.parse(text);
  }
  return { response, text, json };
}

describeIntegration("real SimpleLogin to Bitwarden encrypted alias binding", () => {
  jest.setTimeout(120_000);

  const simpleLoginBaseUrl = process.env["SIMPLELOGIN_BASE_URL"] ?? "http://127.0.0.1:7777";
  const i18n = {
    t: (key: string, ...values: string[]) => `${key} ${values.join(" ")}`.trim(),
  } as I18nService;

  it("creates a real alias, syncs its encrypted identity, and recovers it in another client", async () => {
    const simpleLoginEmail = requiredIntegrationSetting("SIMPLELOGIN_EMAIL");
    const simpleLoginPassword = requiredIntegrationSetting("SIMPLELOGIN_PASSWORD");
    const bitwardenEmail = requiredIntegrationSetting("BITWARDEN_EMAIL");
    const bitwardenPassword = requiredIntegrationSetting("BITWARDEN_PASSWORD");
    const simpleLoginLogin = await fetch(`${simpleLoginBaseUrl}/api/auth/login`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        email: simpleLoginEmail,
        password: simpleLoginPassword,
        device: "Bitwarden encrypted binding integration test",
      }),
    });
    const simpleLoginLoginBody = (await simpleLoginLogin.json()) as { api_key?: unknown };
    if (!simpleLoginLogin.ok || typeof simpleLoginLoginBody.api_key !== "string") {
      throw new Error(`SimpleLogin test login failed (${simpleLoginLogin.status})`);
    }
    const providerToken = simpleLoginLoginBody.api_key;
    const connectionId = randomUUID();
    const aliasService = createSimpleLoginAliasService({
      token: providerToken,
      baseUrl: simpleLoginBaseUrl,
      connectionId,
    });
    const marker = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const hostname = `bound-${marker}.integration.test`;
    const forwarder = new SimpleLoginForwarder(SimpleLogin, i18n, Date.now);
    let aliasId: number | undefined;
    let cipherId: string | undefined;
    let firstClient: AuthenticatedClient | undefined;
    let secondClient: AuthenticatedClient | undefined;

    try {
      const generated = await forwarder.generate(
        {
          algorithm: { forwarder: "simplelogin" } as any,
          website: hostname,
          source: "registration form",
        },
        { token: providerToken, baseUrl: simpleLoginBaseUrl, connectionId },
      );
      aliasId = Number(generated.metadata?.alias.aliasId);
      expect(Number.isSafeInteger(aliasId)).toBe(true);

      const loginCipher = new CipherView();
      loginCipher.type = CipherType.Login;
      loginCipher.name = `Bound login ${marker}`;
      loginCipher.login.username = generated.credential;
      loginCipher.login.password = "account-password";
      bindGeneratedAlias(loginCipher, generated);
      expect(loginCipher.aliasBinding).toEqual(generated.metadata?.alias);

      firstClient = await authenticateBitwardenClient(bitwardenEmail, bitwardenPassword);
      const encryptedContext = await firstClient.client
        .vault()
        .ciphers()
        .encrypt(loginCipher.toSdkCipherView());
      const encryptedCipher = Cipher.fromSdkCipher(encryptedContext.cipher)!;
      const createRequest = new CipherRequest({
        cipher: encryptedCipher,
        encryptedFor: firstClient.userId,
      });
      const serializedCreateRequest = JSON.stringify(createRequest);

      expect(serializedCreateRequest).not.toContain(generated.credential);
      expect(serializedCreateRequest).not.toContain(JSON.stringify(generated.metadata?.alias));
      expect(serializedCreateRequest).not.toContain(providerToken);

      const created = await vaultRequest(firstClient.accessToken, "/ciphers", {
        method: "POST",
        body: serializedCreateRequest,
      });
      expect(created.response.status).toBe(200);
      cipherId = new CipherResponse(created.json).id;
      expect(cipherId).toEqual(expect.any(String));
      expect(created.text).not.toContain(generated.credential);
      expect(created.text).not.toContain(providerToken);

      secondClient = await authenticateBitwardenClient(bitwardenEmail, bitwardenPassword);
      const sync = await vaultRequest(secondClient.accessToken, "/sync?excludeDomains=true");
      expect(sync.response.status).toBe(200);
      expect(sync.text).not.toContain(generated.credential);
      expect(sync.text).not.toContain(providerToken);

      const rawCiphers = (sync.json?.Ciphers ?? sync.json?.ciphers) as unknown[];
      const syncedRawCipher = rawCiphers.find((item: any) => (item.Id ?? item.id) === cipherId);
      expect(syncedRawCipher).toBeDefined();
      const syncedCipher = new Cipher(new CipherData(new CipherResponse(syncedRawCipher)));
      const decryptedSdkView = await secondClient.client
        .vault()
        .ciphers()
        .decrypt(syncedCipher.toSdkCipher());
      const restored = CipherView.fromSdkCipherView(decryptedSdkView)!;

      expect(restored.login.username).toBe(generated.credential);
      expect(restored.aliasBinding).toEqual(generated.metadata?.alias);
      expect(restored.fields).toEqual([]);

      const historyValue = GeneratedCredential.fromJSON(generated.toJSON());
      expect(historyValue.metadata).toBeUndefined();
      expect(JSON.stringify(historyValue)).not.toContain(providerToken);
    } finally {
      if (cipherId && (secondClient || firstClient)) {
        const token = (secondClient ?? firstClient)!.accessToken;
        await vaultRequest(token, `/ciphers/${cipherId}`, { method: "DELETE" }).catch(
          (_error: unknown): void => undefined,
        );
      }
      if (aliasId != null) {
        await aliasService.delete(aliasId).catch((_error: unknown): void => undefined);
      }
      firstClient?.client.free();
      secondClient?.client.free();
    }
  });
});
