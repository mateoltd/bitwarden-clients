import { ReplaySubject, filter, firstValueFrom, skip } from "rxjs";

import { Account } from "@bitwarden/common/auth/abstractions/account.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import {
  AliasSyncDocument,
  AliasSyncStore,
  createAliasSyncDocument,
  mergeAliasSyncDocuments,
  parseAliasSyncDocument,
} from "@bitwarden/common/tools/alias";
import { Vendor } from "@bitwarden/common/tools/extension/vendor/data";
import { UserStateSubject } from "@bitwarden/common/tools/state/user-state-subject";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import {
  AliasConnectionVaultConflictError,
  AliasConnectionVaultStore,
  findAliasConnectionVaultPayloads,
} from "@bitwarden/common/vault/alias-connection";
import { AliasClient, SensitiveString } from "@bitwarden/sdk-internal";

import { CredentialGeneratorService } from "../abstractions";
import { ForwarderOptions } from "../types";

import { SimpleLoginAliasError } from "./simple-login-alias.error";
import { SimpleLoginAliasSettings } from "./simple-login-alias.types";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pendingSyncWrites = new Map<string, Promise<void>>();
const attachedSyncStores = new WeakMap<object, AliasSyncStore>();

export function isSimpleLoginConnectionId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

export function createSimpleLoginConnectionId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function documentsEqual(left: AliasSyncDocument | undefined, right: AliasSyncDocument): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createSubjectSyncStore(
  subject: UserStateSubject<ForwarderOptions>,
  initial: ForwarderOptions,
  account: Account,
): AliasSyncStore {
  let current = initial;
  return {
    async load() {
      let document: AliasSyncDocument;
      try {
        document = current.aliasSync
          ? parseAliasSyncDocument(current.aliasSync)
          : createAliasSyncDocument();
      } catch {
        throw new SimpleLoginAliasError(
          "The encrypted SimpleLogin synchronization journal is invalid",
          "invalid-response",
        );
      }
      return document;
    },
    async save(document) {
      const parsed = parseAliasSyncDocument(document);
      const previous = pendingSyncWrites.get(account.id) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((resolve) => (release = resolve));
      const tail = previous.then(() => next);
      pendingSyncWrites.set(account.id, tail);
      await previous;
      try {
        const stored = current.aliasSync
          ? parseAliasSyncDocument(current.aliasSync)
          : createAliasSyncDocument(parsed.replicaId);
        const merged = mergeAliasSyncDocuments(stored, parsed);
        if (!documentsEqual(current.aliasSync, merged)) {
          const persisted = firstValueFrom(
            subject.pipe(
              skip(1),
              filter((settings) => documentsEqual(settings.aliasSync, merged)),
            ),
          );
          current = { ...current, aliasSync: merged };
          subject.next(current);
          await persisted;
        }
      } finally {
        release();
        if (pendingSyncWrites.get(account.id) === tail) {
          pendingSyncWrites.delete(account.id);
        }
      }
    },
  };
}

/** Attach a non-serializable store to a settings value while the generator owns its subject. */
export function attachSimpleLoginAliasSyncStore(
  settings: ForwarderOptions,
  subject: UserStateSubject<ForwarderOptions>,
  account: Account,
  cipherService?: CipherService,
  syncService?: SyncService,
): ForwarderOptions {
  const local = createSubjectSyncStore(subject, settings, account);
  let store: AliasSyncStore = local;
  if (cipherService && settings.token?.trim() && isSimpleLoginConnectionId(settings.connectionId)) {
    const client = new AliasClient({
      base_url: settings.baseUrl?.trim() || "https://app.simplelogin.io",
      api_token: settings.token as SensitiveString,
      connection_id: settings.connectionId,
    });
    let provider;
    try {
      provider = client.provider_identity();
    } finally {
      client.free();
    }
    store = new AliasConnectionVaultStore({
      cipherService,
      userId: account.id,
      connection: {
        provider: provider.provider,
        providerInstance: provider.instance,
        connectionId: provider.connectionId,
      },
      credential: { token: settings.token, baseUrl: provider.instance },
      local,
      refresh: syncService
        ? async () => {
            await syncService.fullSync(true, { allowThrowOnError: true });
          }
        : undefined,
    });
  }
  attachedSyncStores.set(settings, store);
  return settings;
}

export function simpleLoginAliasSyncStore(settings: ForwarderOptions): AliasSyncStore | undefined {
  return attachedSyncStores.get(settings);
}

function createGeneratorSyncStore(
  generatorService: CredentialGeneratorService,
  account: Account,
): AliasSyncStore {
  const open = async () => {
    const account$ = new ReplaySubject<Account>(1);
    account$.next(account);
    const subject = generatorService.settings<ForwarderOptions>(
      generatorService.forwarder(Vendor.simplelogin),
      { account$ },
    );
    const current = await firstValueFrom(subject);
    return {
      account$,
      subject,
      current,
      close() {
        account$.complete();
        subject.complete();
      },
    };
  };

  return {
    async load() {
      const handle = await open();
      try {
        const store = createSubjectSyncStore(handle.subject, handle.current, account);
        return await store.load();
      } finally {
        handle.close();
      }
    },
    async save(document) {
      const handle = await open();
      try {
        const store = createSubjectSyncStore(handle.subject, handle.current, account);
        await store.save(document);
      } finally {
        handle.close();
      }
    },
  };
}

/** Read current-schema settings without ever creating or persisting connection identity. */
export async function readSimpleLoginAliasSettings(
  generatorService: CredentialGeneratorService,
  account: Account,
  cipherService?: CipherService,
  syncService?: SyncService,
): Promise<SimpleLoginAliasSettings> {
  const account$ = new ReplaySubject<Account>(1);
  account$.next(account);
  const settings$ = generatorService.settings<ForwarderOptions>(
    generatorService.forwarder(Vendor.simplelogin),
    { account$ },
  );
  try {
    const current = await firstValueFrom(settings$);
    if (!isSimpleLoginConnectionId(current.connectionId)) {
      throw new SimpleLoginAliasError(
        "SimpleLogin connection identity is invalid",
        current.connectionId === undefined ? "invalid-credentials" : "invalid-response",
      );
    }
    let settings = current;
    if (!current.token?.trim() && cipherService) {
      if (syncService) {
        await syncService.fullSync(true, { allowThrowOnError: true });
      }
      const recovered = (await findAliasConnectionVaultPayloads(cipherService, account.id)).filter(
        (payload) =>
          payload.credential !== undefined &&
          payload.connection.connectionId === current.connectionId,
      );
      if (recovered.length > 1) {
        throw new AliasConnectionVaultConflictError(
          "Multiple active alias connections require an explicit selection",
        );
      }
      const payload = recovered[0];
      if (payload?.credential) {
        settings = {
          ...current,
          token: payload.credential.token,
          baseUrl: payload.credential.baseUrl,
          aliasSync: payload.sync,
        };
      }
    }
    if (!settings.token?.trim() || !isSimpleLoginConnectionId(settings.connectionId)) {
      throw new SimpleLoginAliasError("SimpleLogin credentials are missing", "invalid-credentials");
    }
    const local = createGeneratorSyncStore(generatorService, account);
    let syncStore: AliasSyncStore = local;
    if (cipherService) {
      const client = new AliasClient({
        base_url: settings.baseUrl?.trim() || "https://app.simplelogin.io",
        api_token: settings.token as SensitiveString,
        connection_id: settings.connectionId,
      });
      let provider;
      try {
        provider = client.provider_identity();
      } finally {
        client.free();
      }
      syncStore = new AliasConnectionVaultStore({
        cipherService,
        userId: account.id,
        connection: {
          provider: provider.provider,
          providerInstance: provider.instance,
          connectionId: provider.connectionId,
        },
        credential: {
          token: settings.token,
          baseUrl: provider.instance,
        },
        local,
        refresh: syncService
          ? async () => {
              await syncService.fullSync(true, { allowThrowOnError: true });
            }
          : undefined,
      });
    }
    return {
      token: settings.token,
      baseUrl: settings.baseUrl || undefined,
      connectionId: settings.connectionId,
      syncStore,
    };
  } finally {
    account$.complete();
    settings$.complete();
  }
}
