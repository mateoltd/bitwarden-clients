/** @jest-environment node */

import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { asUuid } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import {
  AliasSyncDocument,
  AliasSyncStore,
  appendAliasSyncEvent,
  createAliasSyncDocument,
  parseAliasSyncDocument,
  projectAliasSync,
} from "@bitwarden/common/tools/alias";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import {
  AliasConnectionVaultStore,
  findAliasConnectionVaultPayloads,
  isAliasConnectionCipher,
  parseAliasConnectionCipher,
} from "@bitwarden/common/vault/alias-connection";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherData } from "@bitwarden/common/vault/models/data/cipher.data";
import { Cipher } from "@bitwarden/common/vault/models/domain/cipher";
import { CipherRequest } from "@bitwarden/common/vault/models/request/cipher.request";
import { CipherResponse } from "@bitwarden/common/vault/models/response/cipher.response";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { createSimpleLoginAliasService } from "@bitwarden/generator-core";
import { ClientSettings, PasswordManagerClient, TokenProvider } from "@bitwarden/sdk-internal";

const integrationEnabled =
  process.env["ALIAS_CROSS_DEVICE_INTEGRATION"] === "1" &&
  process.env["SIMPLELOGIN_INTEGRATION"] === "1" &&
  process.env["BITWARDEN_SERVER_INTEGRATION"] === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;
const fixtureSize = Number(process.env["ALIAS_SYNC_FIXTURE_SIZE"] ?? "10000");

const bitwardenSettings: ClientSettings = {
  apiUrl: process.env["BITWARDEN_API_URL"] ?? "http://localhost:4000",
  identityUrl: process.env["BITWARDEN_IDENTITY_URL"] ?? "http://localhost:33656",
  userAgent: "Bitwarden alias cross-device integration test",
  deviceType: "SDK",
  bitwardenClientVersion: "2026.7.2",
};

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for alias cross-device integration tests`);
  }
  return value;
}

class MutableTokenProvider implements TokenProvider {
  token?: string;

  async get_access_token(): Promise<string | undefined> {
    return this.token;
  }
}

type AuthenticatedProfile = {
  client: PasswordManagerClient;
  accessToken: string;
  userId: UserId;
  directory: string;
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

async function authenticateBitwardenProfile(
  email: string,
  password: string,
  directory: string,
): Promise<AuthenticatedProfile> {
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
        deviceName: `Alias profile ${directory.split("/").at(-1)}`,
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
  return { client, accessToken: login.accessToken, userId, directory };
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

async function createEncryptedCiphers(
  profile: AuthenticatedProfile,
  requests: CipherRequest[],
  concurrency = 16,
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < requests.length; index += concurrency) {
    const batch = requests.slice(index, index + concurrency);
    const created = await Promise.all(
      batch.map(async (request) => {
        const response = await vaultRequest(profile.accessToken, "/ciphers", {
          method: "POST",
          body: JSON.stringify(request),
        });
        const id = response.json?.id ?? response.json?.Id;
        if (response.response.status !== 200 || typeof id !== "string") {
          throw new Error(
            `Bitwarden fixture create failed (${response.response.status}): ${response.text}`,
          );
        }
        return id;
      }),
    );
    ids.push(...created);
  }
  return ids;
}

function resetSimpleLoginTestRateLimits(): void {
  const container = process.env["SIMPLELOGIN_REDIS_CONTAINER"] ?? "alias-core-sl-redis";
  const keys = execFileSync(
    "docker",
    ["exec", container, "redis-cli", "--scan", "--pattern", "LIMITS:*"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  for (const key of keys) {
    execFileSync("docker", ["exec", container, "redis-cli", "DEL", key]);
  }
}

function removeSimpleLoginTestAliases(aliasIds: number[] = []): void {
  const container = process.env["SIMPLELOGIN_DB_CONTAINER"] ?? "alias-core-sl-db";
  const ids = aliasIds.filter(Number.isSafeInteger).join(",");
  const idPredicate = ids ? ` OR id IN (${ids})` : "";
  execFileSync("docker", [
    "exec",
    container,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-qAt",
    "-U",
    "simplelogin",
    "-d",
    "simplelogin",
    "-c",
    `DELETE FROM alias WHERE note IN ('cross-device primary', 'profile b', 'profile c')${idPredicate};`,
  ]);
}

class DiskAliasSyncStore implements AliasSyncStore {
  private readonly filename: string;

  constructor(
    directory: string,
    private readonly replicaId: string,
  ) {
    this.filename = join(directory, "alias-sync.json");
  }

  async load(): Promise<AliasSyncDocument> {
    try {
      return parseAliasSyncDocument(JSON.parse(readFileSync(this.filename, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const created = createAliasSyncDocument(this.replicaId);
      await this.save(created);
      return created;
    }
  }

  async save(document: AliasSyncDocument): Promise<void> {
    const parsed = parseAliasSyncDocument(document);
    const next = `${this.filename}.next`;
    writeFileSync(next, JSON.stringify(parsed), { mode: 0o600 });
    renameSync(next, this.filename);
  }
}

class RealVaultCipherAdapter implements Pick<
  CipherService,
  "getAllDecryptedIncludingInternal" | "createWithServer" | "clearCache"
> {
  private cache?: CipherView[];
  lastEncryptedSync = "";

  constructor(private readonly profile: AuthenticatedProfile) {}

  async fullSync(): Promise<CipherView[]> {
    const sync = await vaultRequest(this.profile.accessToken, "/sync?excludeDomains=true");
    if (sync.response.status !== 200) {
      throw new Error(`Bitwarden sync failed (${sync.response.status})`);
    }
    this.lastEncryptedSync = sync.text;
    const raw = (sync.json?.Ciphers ?? sync.json?.ciphers ?? []) as unknown[];
    const ciphers = raw.map((value) => new Cipher(new CipherData(new CipherResponse(value))));
    const result = await this.profile.client
      .vault()
      .ciphers()
      .decrypt_list_full_with_failures(ciphers.map((cipher) => cipher.toSdkCipher()));
    if (result.failures.length > 0) {
      throw new Error(`${result.failures.length} vault ciphers failed to decrypt`);
    }
    this.cache = result.successes
      .map((cipher) => CipherView.fromSdkCipherView(cipher))
      .filter((cipher): cipher is CipherView => cipher !== null && cipher !== undefined);
    return this.cache;
  }

  async getAllDecryptedIncludingInternal(_userId: UserId): Promise<CipherView[]> {
    return this.cache ?? this.fullSync();
  }

  async createWithServer(cipher: CipherView, _userId: UserId): Promise<CipherView> {
    const encryption = await this.profile.client
      .vault()
      .ciphers()
      .encrypt(cipher.toSdkCipherView());
    const request = new CipherRequest({
      cipher: Cipher.fromSdkCipher(encryption.cipher)!,
      encryptedFor: this.profile.userId,
    });
    const created = await vaultRequest(this.profile.accessToken, "/ciphers", {
      method: "POST",
      body: JSON.stringify(request),
    });
    if (created.response.status !== 200) {
      throw new Error(`Bitwarden cipher create failed (${created.response.status})`);
    }
    const createdView = await this.decryptResponse(created.json);
    this.cache = [...(this.cache ?? []), createdView];
    return createdView;
  }

  async clearCache(_userId: UserId): Promise<void> {
    this.cache = undefined;
  }

  private async decryptResponse(value: unknown): Promise<CipherView> {
    const encrypted = new Cipher(new CipherData(new CipherResponse(value)));
    const decrypted = await this.profile.client.vault().ciphers().decrypt(encrypted.toSdkCipher());
    const view = CipherView.fromSdkCipherView(decrypted);
    if (!view) {
      throw new Error("Bitwarden returned an unsupported cipher type");
    }
    return view;
  }
}

async function removeBitwardenTestAliasConnections(profile: AuthenticatedProfile): Promise<void> {
  const adapter = new RealVaultCipherAdapter(profile);
  const ids = (await adapter.fullSync())
    .filter(isAliasConnectionCipher)
    .map((cipher) => cipher.id)
    .filter((id): id is string => id !== undefined);
  await deleteCiphers(profile, ids);
}

async function deleteCiphers(profile: AuthenticatedProfile, ids: string[]): Promise<void> {
  for (let index = 0; index < ids.length; index += 100) {
    const deleted = await vaultRequest(profile.accessToken, "/ciphers", {
      method: "DELETE",
      body: JSON.stringify({ ids: ids.slice(index, index + 100) }),
    });
    if (deleted.response.status !== 200) {
      throw new Error(
        `Bitwarden cipher cleanup failed (${deleted.response.status}): ${deleted.text}`,
      );
    }
  }
}

async function removeBitwardenQualificationFixtures(profile: AuthenticatedProfile): Promise<void> {
  const adapter = new RealVaultCipherAdapter(profile);
  const ids = (await adapter.fullSync())
    .filter((cipher) => cipher.name?.startsWith("alias-sync-load-"))
    .map((cipher) => cipher.id)
    .filter((id): id is string => id !== undefined);
  await deleteCiphers(profile, ids);
  const remaining = (await adapter.fullSync()).filter((cipher) =>
    cipher.name?.startsWith("alias-sync-load-"),
  );
  if (remaining.length !== 0) {
    throw new Error(`Bitwarden fixture cleanup left ${remaining.length} ciphers`);
  }
}

describeIntegration("real schema-v1 alias cross-device convergence", () => {
  jest.setTimeout(1_800_000);

  const simpleLoginBaseUrl = process.env["SIMPLELOGIN_BASE_URL"] ?? "http://127.0.0.1:32769";

  it("persists three profiles, survives offline replay and restart, and converges in a 10,000-item vault", async () => {
    const simpleLoginEmail = requiredEnvironmentVariable("SIMPLELOGIN_EMAIL");
    const simpleLoginPassword = requiredEnvironmentVariable("SIMPLELOGIN_PASSWORD");
    const bitwardenEmail = requiredEnvironmentVariable("BITWARDEN_EMAIL");
    const bitwardenPassword = requiredEnvironmentVariable("BITWARDEN_PASSWORD");
    const started = performance.now();
    const root = mkdtempSync(join(tmpdir(), "bitwarden-alias-cross-device-"));
    const directories = [0, 1, 2].map((index) => {
      const directory = join(root, `profile-${index}`);
      mkdirSync(directory, { mode: 0o700 });
      return directory;
    });
    const replicaIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ];
    const connectionId = randomUUID();
    const marker = `alias-sync-load-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const fixtureIds: string[] = [];
    const aliasIds: number[] = [];
    const profiles: AuthenticatedProfile[] = [];
    let providerToken = "";
    let phase = "setup";

    try {
      removeSimpleLoginTestAliases();
      resetSimpleLoginTestRateLimits();
      const simpleLoginLogin = await fetch(`${simpleLoginBaseUrl}/api/auth/login`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          email: simpleLoginEmail,
          password: simpleLoginPassword,
          device: "Bitwarden alias cross-device integration test",
        }),
      });
      const simpleLoginBody = (await simpleLoginLogin.json()) as { api_key?: unknown };
      if (!simpleLoginLogin.ok || typeof simpleLoginBody.api_key !== "string") {
        throw new Error(`SimpleLogin test login failed (${simpleLoginLogin.status})`);
      }
      providerToken = simpleLoginBody.api_key;

      for (const directory of directories) {
        profiles.push(
          await authenticateBitwardenProfile(bitwardenEmail, bitwardenPassword, directory),
        );
      }
      expect(new Set(profiles.map((profile) => profile.directory)).size).toBe(3);
      expect(new Set(profiles.map((profile) => profile.userId)).size).toBe(1);
      await removeBitwardenTestAliasConnections(profiles[0]);
      await removeBitwardenQualificationFixtures(profiles[0]);

      const fixtureViews = Array.from({ length: fixtureSize }, (_, index) => {
        const view = new CipherView();
        view.type = CipherType.Login;
        view.name = `${marker} ${index}`;
        view.login.username = `unrelated-${index}@vault-load.invalid`;
        view.login.password = randomUUID();
        return view;
      });
      const encryptedFixture = await profiles[0].client
        .vault()
        .ciphers()
        .encrypt_list(fixtureViews.map((view) => view.toSdkCipherView()));
      const fixtureRequests = encryptedFixture.map(
        (encrypted) =>
          new CipherRequest({
            cipher: Cipher.fromSdkCipher(encrypted.cipher)!,
            encryptedFor: profiles[0].userId,
          }),
      );
      const encryptedFixturePayload = JSON.stringify(fixtureRequests);
      expect(encryptedFixturePayload).not.toContain(marker);
      expect(encryptedFixturePayload).not.toContain(providerToken);
      fixtureIds.push(...(await createEncryptedCiphers(profiles[0], fixtureRequests)));

      const adapters = profiles.map((profile) => new RealVaultCipherAdapter(profile));
      const afterImport = await adapters[0].fullSync();
      const fixtureCiphers = afterImport.filter((cipher) => cipher.name?.startsWith(marker));
      expect(fixtureCiphers).toHaveLength(fixtureSize);
      fixtureIds.push(...fixtureCiphers.map((cipher) => cipher.id!));
      expect(adapters[0].lastEncryptedSync).not.toContain(marker);
      expect(adapters[0].lastEncryptedSync).not.toContain(providerToken);

      const locals = directories.map(
        (directory, index) => new DiskAliasSyncStore(directory, replicaIds[index]),
      );
      const stores = adapters.map(
        (adapter, index) =>
          new AliasConnectionVaultStore({
            cipherService: adapter,
            userId: profiles[index].userId,
            connection: {
              version: 1,
              connectionId,
            },
            credential: { token: providerToken, baseUrl: `${simpleLoginBaseUrl}/` },
            local: locals[index],
            refresh: async () => {
              await adapter.fullSync();
            },
          }),
      );
      const services = stores.map((syncStore) =>
        createSimpleLoginAliasService({
          token: providerToken,
          baseUrl: simpleLoginBaseUrl,
          connectionId,
          syncStore,
        }),
      );

      const hostname = `cross-device-${Date.now()}.integration.test`;
      phase = "primary create";
      const primary = await services[0].create({ hostname, note: "cross-device primary" });
      aliasIds.push(primary.id);
      const afterPrimary = await stores[0].load();
      expect(afterPrimary.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "provider-dispatched" }),
          expect.objectContaining({ kind: "provider-ack" }),
        ]),
      );
      const primaryOperation = afterPrimary.events.find(
        (event) => event.kind === "provider-operation",
      )!;
      expect(
        afterPrimary.events
          .filter((event) => event.kind === "provider-dispatched" || event.kind === "provider-ack")
          .map((event) => event.operationId),
      ).toEqual([primaryOperation.id, primaryOperation.id]);
      expect(Object.values(projectAliasSync(afterPrimary).operations)).toEqual(
        expect.arrayContaining([expect.objectContaining({ status: "applied" })]),
      );
      phase = "primary encrypted credential carrier";
      const primaryRemote = await adapters[0].fullSync();
      const primaryPayloads = primaryRemote
        .filter(isAliasConnectionCipher)
        .map(parseAliasConnectionCipher)
        .filter((payload) => payload.connection.connectionId === connectionId);
      expect(
        primaryPayloads.map((payload) => ({
          credential: payload.credential !== undefined,
          events: payload.sync.events.map((event) => event.kind),
        })),
      ).toEqual(expect.arrayContaining([expect.objectContaining({ credential: true })]));
      expect(
        (await findAliasConnectionVaultPayloads(adapters[0], profiles[0].userId)).find(
          (payload) => payload.connection.connectionId === connectionId,
        )?.credential?.token,
      ).toBe(providerToken);
      await adapters[1].fullSync();
      await stores[1].load();
      await adapters[2].fullSync();
      await stores[2].load();
      expect(
        Object.values(projectAliasSync(await stores[2].load()).operations).every(
          (operation) => operation.status === "applied",
        ),
      ).toBe(true);

      resetSimpleLoginTestRateLimits();
      phase = "simultaneous create";
      const simultaneousCreates = await Promise.allSettled([
        services[1].create({ hostname: `${hostname}-b`, note: "profile b" }),
        services[2].create({ hostname: `${hostname}-c`, note: "profile c" }),
      ]);
      const createdTogether = simultaneousCreates.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      aliasIds.push(...createdTogether.map((alias) => alias.id));
      expect(createdTogether.length).toBeGreaterThan(0);
      for (const result of simultaneousCreates) {
        if (result.status === "rejected") {
          expect(result.reason).toMatchObject({ code: "rate-limited" });
        }
      }

      phase = "simultaneous update and disable";
      await Promise.all([
        services[1].update(primary.id, { name: "updated from profile b" }),
        services[2].setEnabled(primary.id, false),
      ]);
      resetSimpleLoginTestRateLimits();
      phase = "simultaneous enable and disable";
      await Promise.allSettled([
        services[1].setEnabled(primary.id, true),
        services[2].setEnabled(primary.id, false),
      ]);

      // Profile zero goes offline: the durable local journal advances without touching Bitwarden.
      phase = "offline replay and restart";
      let offline = await locals[0].load();
      offline = appendAliasSyncEvent(offline, {
        kind: "reference-set",
        cipherId: "offline-schema-v1-reference",
        expectedAliasKey: null,
        alias: primary.identity,
      });
      await locals[0].save({ ...offline, events: [...offline.events].reverse() });

      // Force a kill/restart boundary for the first profile and reuse only its persisted directory.
      profiles[0].client.free();
      profiles[0] = await authenticateBitwardenProfile(
        bitwardenEmail,
        bitwardenPassword,
        directories[0],
      );
      adapters[0] = new RealVaultCipherAdapter(profiles[0]);
      stores[0] = new AliasConnectionVaultStore({
        cipherService: adapters[0],
        userId: profiles[0].userId,
        connection: {
          version: 1,
          connectionId,
        },
        credential: { token: providerToken, baseUrl: `${simpleLoginBaseUrl}/` },
        local: new DiskAliasSyncStore(directories[0], replicaIds[0]),
        refresh: async () => {
          await adapters[0].fullSync();
        },
      });
      await stores[0].load();

      // Merge every shard twice. Full-document carriers replay duplicate events by construction.
      for (let round = 0; round < 2; round++) {
        for (let profile = 0; profile < 3; profile++) {
          await adapters[profile].fullSync();
          await stores[profile].load();
        }
      }
      const projections = await Promise.all(
        stores.map(async (store) => projectAliasSync(await store.load())),
      );
      expect(projections[0]).toEqual(projections[1]);
      expect(projections[1]).toEqual(projections[2]);
      expect(projections[0].references["offline-schema-v1-reference"].alias).toEqual(
        primary.identity,
      );
      expect(projections[0].conflicts).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "provider-state" })]),
      );
      const conflictResolver = createSimpleLoginAliasService({
        token: providerToken,
        baseUrl: simpleLoginBaseUrl,
        connectionId,
        syncStore: stores[0],
      });
      await expect(conflictResolver.setEnabled(primary.id, true)).rejects.toMatchObject({
        code: "conflict",
      });
      for (const conflict of projections[0].conflicts.filter(
        (candidate) => candidate.kind === "provider-state" || candidate.kind === "alias-identity",
      )) {
        await conflictResolver.resolveSynchronizationConflict(
          conflict.id,
          conflict.eventIds.at(-1)!,
        );
      }
      for (let profile = 0; profile < 3; profile++) {
        await adapters[profile].fullSync();
        await stores[profile].load();
      }

      // Normal encrypted export/import restoration of one schema-v1 carrier.
      phase = "encrypted export/import restoration";
      const profileZeroViews = await adapters[0].fullSync();
      phase = "encrypted export before backup";
      const beforeBackup = await findAliasConnectionVaultPayloads(adapters[0], profiles[0].userId);
      expect(
        beforeBackup.find((payload) => payload.connection.connectionId === connectionId)?.credential
          ?.token,
      ).toBe(providerToken);
      const carrier = profileZeroViews.find(
        (cipher) =>
          isAliasConnectionCipher(cipher) &&
          parseAliasConnectionCipher(cipher).sync.replicaId === replicaIds[0] &&
          parseAliasConnectionCipher(cipher).credential !== undefined,
      )!;
      const carrierEncryption = await profiles[0].client
        .vault()
        .ciphers()
        .encrypt(carrier.toSdkCipherView());
      const carrierRequest = new CipherRequest({
        cipher: Cipher.fromSdkCipher(carrierEncryption.cipher)!,
        encryptedFor: profiles[0].userId,
      });
      const carrierBackup = JSON.stringify(carrierRequest);
      expect(carrierBackup).not.toContain(providerToken);
      expect(carrierBackup).not.toContain(connectionId);
      expect(
        (
          await vaultRequest(profiles[0].accessToken, `/ciphers/${carrier.id}`, {
            method: "DELETE",
          })
        ).response.status,
      ).toBe(200);
      expect(
        (
          await vaultRequest(profiles[0].accessToken, "/ciphers", {
            method: "POST",
            body: carrierBackup,
          })
        ).response.status,
      ).toBe(200);
      phase = "encrypted restore";
      await adapters[0].fullSync();
      const restored = await findAliasConnectionVaultPayloads(adapters[0], profiles[0].userId);
      expect(
        restored.find((payload) => payload.connection.connectionId === connectionId)?.credential
          ?.token,
      ).toBe(providerToken);

      // Delete wins over a simultaneous stale enable and remains terminal after every replay.
      phase = "simultaneous delete and enable";
      resetSimpleLoginTestRateLimits();
      await Promise.allSettled([
        services[1].delete(primary.id),
        services[2].setEnabled(primary.id, true),
      ]);
      for (let profile = 0; profile < 3; profile++) {
        await adapters[profile].fullSync();
        await stores[profile].load();
      }
      const afterDelete = projectAliasSync(await stores[0].load());
      const projectedPrimary = Object.values(afterDelete.aliases).find(
        (alias) => alias.identity.aliasId === String(primary.id),
      );
      expect(projectedPrimary?.status).toBe("deleted");

      const activeProfileZero = createSimpleLoginAliasService({
        token: providerToken,
        baseUrl: simpleLoginBaseUrl,
        connectionId,
        syncStore: stores[0],
      });
      await activeProfileZero.removeConnection();
      phase = "connection removal";
      await adapters[2].fullSync();
      await stores[2].load();
      await expect(services[2].create()).rejects.toMatchObject({ code: "conflict" });
      const recoveredAfterRemoval = await findAliasConnectionVaultPayloads(
        adapters[2],
        profiles[2].userId,
      );
      expect(
        recoveredAfterRemoval.find((payload) => payload.connection.connectionId === connectionId)
          ?.credential,
      ).toBeUndefined();

      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(1_800_000);
      process.stdout.write(
        `${JSON.stringify({
          fixtureSize,
          persistedProfiles: 3,
          elapsedMilliseconds: Math.round(elapsed),
          conflictsRetained: projections[0].conflicts.length,
        })}\n`,
      );
    } catch (error) {
      const wrapped = new Error(`${phase}: ${(error as Error).message}`) as Error & {
        cause?: unknown;
      };
      wrapped.cause = error;
      throw wrapped;
    } finally {
      const cleanupProfile = profiles.find((profile) => profile.accessToken);
      if (cleanupProfile) {
        const adapter = new RealVaultCipherAdapter(cleanupProfile);
        const views = await adapter.fullSync().catch((): CipherView[] => []);
        const carrierIds = views
          .filter(isAliasConnectionCipher)
          .filter((cipher) => {
            try {
              return parseAliasConnectionCipher(cipher).connection.connectionId === connectionId;
            } catch {
              return false;
            }
          })
          .map((cipher) => cipher.id!);
        const markerIds = views
          .filter((cipher) => cipher.name?.startsWith(marker))
          .map((cipher) => cipher.id!);
        const ids = [...new Set([...fixtureIds, ...markerIds, ...carrierIds])];
        await deleteCiphers(cleanupProfile, ids);
        await removeBitwardenQualificationFixtures(cleanupProfile);
      }
      removeSimpleLoginTestAliases(aliasIds);
      for (const profile of profiles) {
        profile.client.free();
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
