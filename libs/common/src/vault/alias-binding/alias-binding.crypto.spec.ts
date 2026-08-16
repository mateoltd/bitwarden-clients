import { randomBytes } from "crypto";

import { PasswordManagerClient, TokenProvider } from "@bitwarden/sdk-internal";

import { asUuid } from "../../platform/abstractions/sdk/sdk.service";
import { UserId } from "../../types/guid";
import { CipherType } from "../enums";
import { Cipher } from "../models/domain/cipher";
import { CipherRequest } from "../models/request/cipher.request";
import { CipherView } from "../models/view/cipher.view";

import { bindGeneratedAlias } from "./alias-binding";

const userId = "89d55fa7-395c-48a0-966a-3d412954082f";
const alias = {
  version: 1 as const,
  connectionId: "11111111-1111-4111-8111-111111111111",
  aliasId: "opaque:314159",
  address: "sdk-round-trip@sl.test",
};

class EmptyTokenProvider implements TokenProvider {
  async get_access_token(): Promise<undefined> {
    return undefined;
  }
}

describe("alias binding SDK encryption", () => {
  let client: PasswordManagerClient;

  beforeAll(async () => {
    client = new PasswordManagerClient(new EmptyTokenProvider());
    const userKey = randomBytes(64).toString("base64");
    const keyPair = client.crypto().make_key_pair(userKey);
    await client.crypto().initialize_user_crypto({
      userId: asUuid(userId),
      email: "alias-binding@bitwarden.test",
      kdfParams: { pBKDF2: { iterations: 600_000 } },
      accountCryptographicState: { V1: { private_key: keyPair.userKeyEncryptedPrivateKey } },
      method: { decryptedKey: { decrypted_user_key: userKey } },
    });
    await client.crypto().initialize_org_crypto({ organizationKeys: new Map() });
  });

  afterAll(() => client.free());

  it("encrypts login.aliasReference and recovers it after decrypt and restart", async () => {
    const original = new CipherView();
    original.type = CipherType.Login;
    original.name = "Alias-bound account";
    original.login.username = alias.address;
    original.login.password = "not-the-token";
    bindGeneratedAlias(original, {
      credential: alias.address,
      metadata: { kind: "email-alias", alias },
    });

    const encryption = await client.vault().ciphers().encrypt(original.toSdkCipherView());
    const encrypted = Cipher.fromSdkCipher(encryption.cipher)!;
    const serializedVaultData = JSON.stringify(encrypted);

    expect(serializedVaultData).not.toContain(alias.address);
    expect(serializedVaultData).not.toContain(alias.aliasId);

    const request = new CipherRequest({ cipher: encrypted, encryptedFor: userId as UserId });
    expect(encrypted.type).toBe(CipherType.Login);
    expect(encrypted.data).toEqual(expect.any(String));
    expect(encrypted.login).toBeUndefined();
    expect(request.data).toBe(encrypted.data);
    expect(request.login).toBeUndefined();

    const decryptedSdkView = await client.vault().ciphers().decrypt(encrypted.toSdkCipher());
    const restored = CipherView.fromSdkCipherView(decryptedSdkView)!;

    expect(restored.login.username).toBe(alias.address);
    expect(restored.aliasBinding).toEqual(alias);
    expect(restored.fields).toEqual([]);

    const restartedClientView = CipherView.fromJSON(restored.toJSON() as never);
    expect(restartedClientView.aliasBinding).toEqual(alias);
    expect(restartedClientView.login.aliasReference).toBe(restored.login.aliasReference);
  });
});
