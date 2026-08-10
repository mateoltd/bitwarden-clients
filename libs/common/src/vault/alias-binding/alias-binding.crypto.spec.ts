import { randomBytes } from "crypto";

import { PasswordManagerClient, TokenProvider } from "@bitwarden/sdk-internal";

import { asUuid } from "../../platform/abstractions/sdk/sdk.service";
import { CipherType } from "../enums";
import { Cipher } from "../models/domain/cipher";
import { CipherView } from "../models/view/cipher.view";

import { ALIAS_BINDING_FIELD_NAME } from "./alias-binding";

const userId = "89d55fa7-395c-48a0-966a-3d412954082f";
const alias = {
  version: 1 as const,
  provider: "simplelogin" as const,
  id: "314159",
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

  it("encrypts the reserved field and recovers it in a second client view", async () => {
    const original = new CipherView();
    original.type = CipherType.Login;
    original.name = "Alias-bound account";
    original.login.username = alias.address;
    original.login.password = "not-the-token";
    original.aliasBinding = alias;

    const encryption = await client.vault().ciphers().encrypt(original.toSdkCipherView());
    const encrypted = Cipher.fromSdkCipher(encryption.cipher)!;
    const serializedVaultData = JSON.stringify(encrypted);

    expect(serializedVaultData).not.toContain(ALIAS_BINDING_FIELD_NAME);
    expect(serializedVaultData).not.toContain(alias.address);
    expect(serializedVaultData).not.toContain(alias.id);

    const decryptedSdkView = await client.vault().ciphers().decrypt(encrypted.toSdkCipher());
    const restored = CipherView.fromSdkCipherView(decryptedSdkView)!;

    expect(restored.login.username).toBe(alias.address);
    expect(restored.aliasBinding).toEqual(alias);
    expect(restored.fields).toEqual([]);

    const restartedClientView = CipherView.fromJSON(restored.toJSON() as any);
    expect(restartedClientView.aliasBinding).toEqual(alias);
    expect(restartedClientView.fields).toEqual([]);
  });
});
