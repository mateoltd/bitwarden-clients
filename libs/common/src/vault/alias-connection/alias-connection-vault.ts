import { CipherListView } from "@bitwarden/sdk-internal";

import {
  AliasProviderConnection,
  AliasSyncDocument,
  AliasSyncStore,
  aliasConnectionKey,
  appendAliasSyncEvent,
  mergeAliasSyncDocuments,
  parseAliasSyncDocument,
  projectAliasSync,
} from "../../tools/alias";
import { UserId } from "../../types/guid";
import type { CipherService } from "../abstractions/cipher.service";
import { CipherRepromptType, CipherType, FieldType } from "../enums";
import { CipherView } from "../models/view/cipher.view";
import { FieldView } from "../models/view/field.view";

export const ALIAS_CONNECTION_CIPHER_NAME = "bitwarden.alias.connection.v1";
export const ALIAS_CONNECTION_MARKER_FIELD = "bitwarden.alias.connection.marker";
export const ALIAS_CONNECTION_PAYLOAD_FIELD = "bitwarden.alias.connection.payload";
export const ALIAS_CONNECTION_VERSION = 1 as const;
const ALIAS_CONNECTION_FIELD_PART_SIZE = 1_500;
const ALIAS_CONNECTION_SEGMENT_SIZE = 60_000;

export type AliasConnectionCredential = {
  token: string;
  baseUrl: string;
};

export type AliasConnectionVaultPayload = {
  version: typeof ALIAS_CONNECTION_VERSION;
  connection: AliasProviderConnection;
  credential?: AliasConnectionCredential;
  sync: AliasSyncDocument;
};

export class AliasConnectionVaultConflictError extends Error {
  constructor(message = "The alias connection changed on another vault session") {
    super(message);
    this.name = "AliasConnectionVaultConflictError";
  }
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
}

function markerField(): FieldView {
  const field = new FieldView();
  field.type = FieldType.Text;
  field.name = ALIAS_CONNECTION_MARKER_FIELD;
  field.value = "1";
  return field;
}

function payloadFields(payload: AliasConnectionVaultPayload): FieldView[] {
  const encoded = JSON.stringify(payload);
  const fields: FieldView[] = [];
  for (
    let offset = 0, index = 0;
    offset < encoded.length;
    offset += ALIAS_CONNECTION_FIELD_PART_SIZE, index++
  ) {
    const field = new FieldView();
    field.type = FieldType.Hidden;
    field.name = `${ALIAS_CONNECTION_PAYLOAD_FIELD}.${index.toString().padStart(4, "0")}`;
    field.value = encoded.slice(offset, offset + ALIAS_CONNECTION_FIELD_PART_SIZE);
    fields.push(field);
  }
  return fields;
}

function hasMarker(fields: { name?: string; value?: string }[] | undefined): boolean {
  return (
    fields?.some((field) => field.name === ALIAS_CONNECTION_MARKER_FIELD && field.value === "1") ===
    true
  );
}

/** True only for the reserved, encrypted alias connection carrier. */
export function isAliasConnectionCipher(cipher: CipherView): boolean {
  return (
    cipher.organizationId == null &&
    cipher.type === CipherType.SecureNote &&
    cipher.name === ALIAS_CONNECTION_CIPHER_NAME &&
    hasMarker(cipher.fields)
  );
}

/** List-view equivalent used to keep the carrier out of every normal vault surface. */
export function isAliasConnectionCipherListView(cipher: CipherListView): boolean {
  return (
    cipher.organizationId == null &&
    cipher.type === "secureNote" &&
    cipher.name === ALIAS_CONNECTION_CIPHER_NAME &&
    hasMarker(cipher.fields)
  );
}

function parseConnection(value: unknown): AliasProviderConnection {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasExactKeys(value, ["version", "connectionId"])
  ) {
    throw new AliasConnectionVaultConflictError("The encrypted alias connection is malformed");
  }
  const candidate = value as Partial<AliasProviderConnection>;
  if (candidate.version !== ALIAS_CONNECTION_VERSION) {
    throw new AliasConnectionVaultConflictError("The encrypted alias connection is malformed");
  }
  const connection: AliasProviderConnection = {
    version: candidate.version,
    connectionId: candidate.connectionId ?? "",
  };
  // The key helper applies all schema-v1 provider and UUID validation.
  aliasConnectionKey(connection);
  return connection;
}

export function parseAliasConnectionCipher(cipher: CipherView): AliasConnectionVaultPayload {
  if (!isAliasConnectionCipher(cipher)) {
    throw new AliasConnectionVaultConflictError("The vault item is not an alias connection");
  }
  const encoded = cipher.fields
    .filter(
      (field) =>
        field.name?.startsWith(`${ALIAS_CONNECTION_PAYLOAD_FIELD}.`) &&
        field.type === FieldType.Hidden,
    )
    .sort((left, right) => left.name!.localeCompare(right.name!))
    .map((field) => field.value ?? "")
    .join("");
  if (!encoded) {
    throw new AliasConnectionVaultConflictError("The encrypted alias connection has no payload");
  }
  try {
    const candidate = JSON.parse(encoded) as Partial<AliasConnectionVaultPayload>;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      !hasExactKeys(
        candidate,
        candidate.credential === undefined
          ? ["version", "connection", "sync"]
          : ["version", "connection", "credential", "sync"],
      ) ||
      candidate.version !== ALIAS_CONNECTION_VERSION
    ) {
      throw new Error("unsupported version");
    }
    const connection = parseConnection(candidate.connection);
    const sync = parseAliasSyncDocument(candidate.sync);
    let credential: AliasConnectionCredential | undefined;
    if (candidate.credential !== undefined) {
      if (
        !candidate.credential ||
        typeof candidate.credential !== "object" ||
        Array.isArray(candidate.credential) ||
        !hasExactKeys(candidate.credential, ["token", "baseUrl"]) ||
        typeof candidate.credential.token !== "string" ||
        !candidate.credential.token.trim() ||
        typeof candidate.credential.baseUrl !== "string"
      ) {
        throw new Error("missing credential");
      }
      credential = {
        token: candidate.credential.token,
        baseUrl: candidate.credential.baseUrl,
      };
    }
    return { version: ALIAS_CONNECTION_VERSION, connection, credential, sync };
  } catch (error) {
    if (error instanceof AliasConnectionVaultConflictError) {
      throw error;
    }
    throw new AliasConnectionVaultConflictError("The encrypted alias connection is malformed");
  }
}

export function createAliasConnectionCipher(payload: AliasConnectionVaultPayload): CipherView {
  const cipher = new CipherView();
  cipher.type = CipherType.SecureNote;
  cipher.name = ALIAS_CONNECTION_CIPHER_NAME;
  cipher.reprompt = CipherRepromptType.Password;
  cipher.fields = [markerField(), ...payloadFields(payload)];
  return cipher;
}

export type AliasConnectionVaultStoreOptions = {
  cipherService: Pick<
    CipherService,
    "getAllDecryptedIncludingInternal" | "createWithServer" | "clearCache"
  >;
  userId: UserId;
  connection: AliasProviderConnection;
  credential: AliasConnectionCredential;
  local: AliasSyncStore;
  /** Real sync callback used to resolve an unknown carrier-create outcome. */
  refresh?: () => Promise<void>;
};

/**
 * Replicates one schema-v1 connection journal through the real encrypted vault sync path.
 * The local encrypted store is written first so offline/process-kill recovery remains possible.
 */
export class AliasConnectionVaultStore implements AliasSyncStore {
  private readonly key: string;

  constructor(private readonly options: AliasConnectionVaultStoreOptions) {
    this.key = aliasConnectionKey(options.connection);
  }

  async load(): Promise<AliasSyncDocument> {
    let local = await this.options.local.load();
    if (!projectAliasSync(local).connections[this.key]) {
      local = appendAliasSyncEvent(local, {
        kind: "connection-upsert",
        connection: this.options.connection,
      });
      await this.options.local.save(local);
    }
    const records = await this.readRecords();
    this.assertCredentials(records.map(({ payload }) => payload));
    const merged = mergeAliasSyncDocuments(local, ...records.map(({ payload }) => payload.sync));
    await this.options.local.save(merged);
    await this.publishMissing(merged, records);
    return merged;
  }

  async save(document: AliasSyncDocument): Promise<void> {
    const parsed = parseAliasSyncDocument(document);
    await this.options.local.save(parsed);
    const local = await this.options.local.load();
    const records = await this.readRecords();
    this.assertCredentials(records.map(({ payload }) => payload));
    const merged = mergeAliasSyncDocuments(local, ...records.map(({ payload }) => payload.sync));
    await this.options.local.save(merged);
    await this.publishMissing(merged, records);
  }

  private async readRecords(): Promise<
    { cipher: CipherView; payload: AliasConnectionVaultPayload }[]
  > {
    return (await this.options.cipherService.getAllDecryptedIncludingInternal(this.options.userId))
      .filter(isAliasConnectionCipher)
      .map((cipher) => ({ cipher, payload: parseAliasConnectionCipher(cipher) }))
      .filter((record) => aliasConnectionKey(record.payload.connection) === this.key);
  }

  private assertCredentials(payloads: AliasConnectionVaultPayload[]): void {
    const documents = payloads.map((payload) => payload.sync);
    const projection = documents.length
      ? projectAliasSync(mergeAliasSyncDocuments(documents[0], ...documents.slice(1)))
      : undefined;
    const removed = projection?.connections[this.key]?.status === "removed";
    if (removed || payloads.length === 0) {
      return;
    }
    const credentials = payloads.flatMap((payload) =>
      payload.credential ? [payload.credential] : [],
    );
    if (credentials.length === 0) {
      throw new AliasConnectionVaultConflictError(
        "The encrypted alias connection has no credential carrier",
      );
    }
    for (const credential of credentials) {
      if (
        credential.token !== this.options.credential.token ||
        credential.baseUrl !== this.options.credential.baseUrl
      ) {
        throw new AliasConnectionVaultConflictError(
          "The alias connection credential changed on another vault session",
        );
      }
    }
  }

  private async createRecord(
    sync: AliasSyncDocument,
    credential?: AliasConnectionCredential,
  ): Promise<void> {
    const cipher = createAliasConnectionCipher({
      version: ALIAS_CONNECTION_VERSION,
      connection: this.options.connection,
      credential,
      sync,
    });
    try {
      await this.options.cipherService.createWithServer(cipher, this.options.userId);
    } catch {
      throw new AliasConnectionVaultConflictError(
        "The encrypted alias connection could not be created",
      );
    }
  }

  private async publishMissing(
    document: AliasSyncDocument,
    records: { cipher: CipherView; payload: AliasConnectionVaultPayload }[],
  ): Promise<void> {
    const published = new Set(
      records.flatMap(({ payload }) => payload.sync.events.map((event) => event.id)),
    );
    const missing = document.events.filter((event) => !published.has(event.id));
    if (missing.length === 0) {
      return;
    }
    const chunks: (typeof missing)[] = [];
    let current: typeof missing = [];
    for (const event of missing) {
      const candidate = [...current, event];
      const size = JSON.stringify({ ...document, events: candidate }).length;
      if (current.length > 0 && size > ALIAS_CONNECTION_SEGMENT_SIZE) {
        chunks.push(current);
        current = [event];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) {
      chunks.push(current);
    }

    const removed = projectAliasSync(document).connections[this.key]?.status === "removed";
    let needsCredential =
      !removed && records.every(({ payload }) => payload.credential === undefined);
    for (const events of chunks) {
      const segment = { ...document, events };
      const credential = needsCredential ? this.options.credential : undefined;
      try {
        await this.createRecord(segment, credential);
      } catch {
        if (!this.options.refresh) {
          throw new AliasConnectionVaultConflictError();
        }
        await this.options.refresh();
        await this.options.cipherService.clearCache(this.options.userId);
        const refreshed = await this.readRecords();
        const refreshedIds = new Set(
          refreshed.flatMap(({ payload }) => payload.sync.events.map((event) => event.id)),
        );
        if (!events.every((event) => refreshedIds.has(event.id))) {
          await this.createRecord(segment, credential);
        }
      }
      needsCredential = false;
    }
  }
}

export async function findAliasConnectionVaultPayloads(
  cipherService: Pick<CipherService, "getAllDecryptedIncludingInternal">,
  userId: UserId,
): Promise<AliasConnectionVaultPayload[]> {
  const payloads = (await cipherService.getAllDecryptedIncludingInternal(userId))
    .filter(isAliasConnectionCipher)
    .map(parseAliasConnectionCipher);
  const groups = new Map<string, AliasConnectionVaultPayload[]>();
  for (const payload of payloads) {
    const key = aliasConnectionKey(payload.connection);
    groups.set(key, [...(groups.get(key) ?? []), payload]);
  }
  return [...groups.entries()].map(([key, entries]) => {
    const sync = mergeAliasSyncDocuments(
      entries[0].sync,
      ...entries.slice(1).map((entry) => entry.sync),
    );
    const removed = projectAliasSync(sync).connections[key]?.status === "removed";
    const credentials = new Map(
      entries
        .filter((entry) => entry.credential !== undefined)
        .map((entry) => [JSON.stringify(entry.credential), entry.credential!]),
    );
    if (!removed && credentials.size > 1) {
      throw new AliasConnectionVaultConflictError(
        "Alias profiles disagree about the encrypted provider credential",
      );
    }
    return {
      version: ALIAS_CONNECTION_VERSION,
      connection: entries[0].connection,
      credential: removed ? undefined : credentials.values().next().value,
      sync,
    };
  });
}
