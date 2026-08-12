import { randomBytes } from "crypto";

import { PasswordManagerClient, TokenProvider } from "@bitwarden/sdk-internal";

import { asUuid } from "../../platform/abstractions/sdk/sdk.service";
import {
  AliasSyncDocument,
  AliasSyncStore,
  appendAliasSyncEvent,
  createAliasSyncDocument,
  emailAliasKey,
  projectAliasSync,
} from "../../tools/alias";
import { Cipher } from "../models/domain/cipher";
import { CipherView } from "../models/view/cipher.view";

import {
  ALIAS_CONNECTION_MARKER_FIELD,
  ALIAS_CONNECTION_PAYLOAD_FIELD,
  AliasConnectionVaultConflictError,
  AliasConnectionVaultStore,
  createAliasConnectionCipher,
  findAliasConnectionVaultPayloads,
  isAliasConnectionCipher,
  parseAliasConnectionCipher,
} from "./alias-connection-vault";

const userId = "89d55fa7-395c-48a0-966a-3d412954082f";
const replicaId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const connection = {
  provider: "simplelogin" as const,
  providerInstance: "https://app.simplelogin.io/",
  connectionId: "11111111-1111-4111-8111-111111111111",
};
const token = "provider-secret-must-remain-encrypted";

class EmptyTokenProvider implements TokenProvider {
  async get_access_token(): Promise<undefined> {
    return undefined;
  }
}

describe("alias connection vault carrier", () => {
  let client: PasswordManagerClient;

  beforeAll(async () => {
    client = new PasswordManagerClient(new EmptyTokenProvider());
    const userKey = randomBytes(64).toString("base64");
    const keyPair = client.crypto().make_key_pair(userKey);
    await client.crypto().initialize_user_crypto({
      userId: asUuid(userId),
      email: "alias-sync@bitwarden.test",
      kdfParams: { pBKDF2: { iterations: 600_000 } },
      accountCryptographicState: { V1: { private_key: keyPair.userKeyEncryptedPrivateKey } },
      method: { decryptedKey: { decrypted_user_key: userKey } },
    });
    await client.crypto().initialize_org_crypto({ organizationKeys: new Map() });
  });

  afterAll(() => client.free());

  it("does not hide an ordinary secure note that happens to use the reserved name", () => {
    const ordinary = new CipherView();
    ordinary.type = 2;
    ordinary.name = "bitwarden.alias.connection.v1";

    expect(isAliasConnectionCipher(ordinary)).toBe(false);
  });

  it("encrypts credentials, journal, marker, and metadata through the normal cipher path", async () => {
    let sync = createAliasSyncDocument(replicaId);
    sync = appendAliasSyncEvent(
      sync,
      { kind: "connection-upsert", connection },
      "00000001-0000-4000-8000-000000000001",
    );
    const view = createAliasConnectionCipher({
      version: 1,
      connection,
      credential: { token, baseUrl: connection.providerInstance },
      sync,
    });

    expect(isAliasConnectionCipher(view)).toBe(true);
    expect(parseAliasConnectionCipher(view)).toMatchObject({
      connection,
      credential: { token, baseUrl: connection.providerInstance },
    });

    const encryption = await client.vault().ciphers().encrypt(view.toSdkCipherView());
    const encrypted = Cipher.fromSdkCipher(encryption.cipher)!;
    const serialized = JSON.stringify(encrypted);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(connection.connectionId);
    expect(serialized).not.toContain(ALIAS_CONNECTION_MARKER_FIELD);
    expect(serialized).not.toContain(ALIAS_CONNECTION_PAYLOAD_FIELD);

    const decrypted = await client.vault().ciphers().decrypt(encrypted.toSdkCipher());
    const restored = parseAliasConnectionCipher(CipherView.fromSdkCipherView(decrypted)!);
    expect(restored.credential?.token).toBe(token);
    expect(restored.sync).toEqual(sync);
  });

  it("fails closed for malformed or removed connection payloads without reflecting credentials", () => {
    const cipher = createAliasConnectionCipher({
      version: 1,
      connection,
      credential: { token, baseUrl: connection.providerInstance },
      sync: createAliasSyncDocument(replicaId),
    });
    cipher.fields.find((field) => field.name?.startsWith(ALIAS_CONNECTION_PAYLOAD_FIELD))!.value =
      JSON.stringify({ token, malformed: true });

    let error: Error;
    try {
      parseAliasConnectionCipher(cipher);
      throw new Error("expected parsing to fail");
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeInstanceOf(AliasConnectionVaultConflictError);
    expect(error.message).not.toContain(token);
  });

  it("converges three independently persisted profiles after offline edits and restarts", async () => {
    const remote = new Map<string, CipherView>();
    let nextCipherId = 1;
    const clone = (cipher: CipherView) => CipherView.fromJSON(cipher.toJSON() as never);
    const cipherService = {
      getAllDecryptedIncludingInternal: async () => [...remote.values()].map(clone),
      createWithServer: async (cipher: CipherView) => {
        const created = clone(cipher);
        created.id = `00000000-0000-4000-8000-${String(nextCipherId++).padStart(12, "0")}`;
        remote.set(created.id, clone(created));
        return clone(created);
      },
      updateWithServer: async (cipher: CipherView) => {
        if (!cipher.id || !remote.has(cipher.id)) {
          throw new Error("missing remote carrier");
        }
        remote.set(cipher.id, clone(cipher));
        return clone(cipher);
      },
      clearCache: async (): Promise<void> => undefined,
    };
    const persisted = new Map<string, AliasSyncDocument>();
    const replicaIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ];
    const local = (profile: number): AliasSyncStore => ({
      load: async () =>
        persisted.get(String(profile)) ?? createAliasSyncDocument(replicaIds[profile]),
      save: async (document) => {
        persisted.set(String(profile), document);
      },
    });
    const open = (profile: number) =>
      new AliasConnectionVaultStore({
        cipherService,
        userId: userId as never,
        connection,
        credential: { token, baseUrl: connection.providerInstance },
        local: local(profile),
      });

    await Promise.all([open(0).load(), open(1).load(), open(2).load()]);
    expect(remote.size).toBe(3);

    const firstAlias = {
      version: 2 as const,
      provider: "simplelogin" as const,
      providerInstance: connection.providerInstance,
      connectionId: connection.connectionId,
      aliasId: "41",
      address: "first@sl.test",
    };
    const secondAlias = { ...firstAlias, aliasId: "42", address: "second@sl.test" };

    // Profile zero is offline: its event reaches only its independently persisted local journal.
    const staleOffline = await local(0).load();
    await local(0).save(
      appendAliasSyncEvent(staleOffline, {
        kind: "reference-set",
        cipherId: "cipher-offline",
        expectedAliasKey: null,
        alias: firstAlias,
      }),
    );

    let second = await open(1).load();
    second = appendAliasSyncEvent(second, {
      kind: "reference-set",
      cipherId: "cipher-online",
      expectedAliasKey: null,
      alias: secondAlias,
    });
    await open(1).save(second);

    // A new store instance is a forced process restart. It repairs the offline profile's shard and
    // deduplicates the events replayed in the other profiles' full-document carriers.
    await open(0).load();
    const projections = [];
    for (let profile = 0; profile < 3; profile++) {
      projections.push(projectAliasSync(await open(profile).load()));
    }
    expect(projections[0]).toEqual(projections[1]);
    expect(projections[1]).toEqual(projections[2]);
    expect(projections[2].references["cipher-offline"].alias).toEqual(firstAlias);
    expect(projections[2].references["cipher-online"].alias).toEqual(secondAlias);

    // A removal tombstone merged after another profile's stale retarget remains terminal.
    let removed = await open(2).load();
    removed = appendAliasSyncEvent(removed, { kind: "connection-remove", connection });
    await open(2).save(removed);
    const staleRetarget = appendAliasSyncEvent(await local(0).load(), {
      kind: "reference-set",
      cipherId: "cipher-offline",
      expectedAliasKey: emailAliasKey(firstAlias),
      alias: secondAlias,
    });
    await open(0).save(staleRetarget);

    const recovered = await findAliasConnectionVaultPayloads(cipherService, userId as never);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].credential).toBeUndefined();
    expect(projectAliasSync(recovered[0].sync).connections).toEqual(
      expect.objectContaining({
        [`simplelogin\n${connection.providerInstance}\n${connection.connectionId}`]:
          expect.objectContaining({
            status: "removed",
          }),
      }),
    );
  });
});
