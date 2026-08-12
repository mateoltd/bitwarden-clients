import { EmailAliasIdentity, parseEmailAliasIdentity } from "./email-alias";

export const ALIAS_SYNC_VERSION = 1 as const;

export type AliasVectorClock = Record<string, number>;

export type AliasProviderConnection = {
  provider: "simplelogin";
  providerInstance: string;
  connectionId: string;
};

export type AliasProviderPatch = {
  name?: string | null;
  note?: string | null;
  mailboxIds?: number[];
  pgpDisabled?: boolean;
  pinned?: boolean;
};

export type AliasCreateIntent =
  | {
      kind: "random";
      hostname?: string;
      mode?: "uuid" | "word";
      note?: string;
    }
  | {
      kind: "custom";
      hostname?: string;
      /** Hash or opaque caller label only. A signed suffix must never be journaled. */
      requestFingerprint: string;
    };

export type AliasProviderOperation =
  | { operation: "create"; connection: AliasProviderConnection; request: AliasCreateIntent }
  | { operation: "update"; alias: EmailAliasIdentity; patch: AliasProviderPatch }
  | { operation: "enable"; alias: EmailAliasIdentity }
  | { operation: "disable"; alias: EmailAliasIdentity }
  | { operation: "delete"; alias: EmailAliasIdentity };

export type AliasProviderSnapshot = {
  alias: EmailAliasIdentity;
  enabled: boolean;
  name?: string | null;
  note?: string | null;
  mailboxIds?: number[];
  pgpDisabled?: boolean;
  pinned?: boolean;
};

type AliasSyncEventBase = {
  version: typeof ALIAS_SYNC_VERSION;
  id: string;
  replicaId: string;
  clock: AliasVectorClock;
};

export type AliasSyncEvent = AliasSyncEventBase &
  (
    | { kind: "connection-upsert"; connection: AliasProviderConnection }
    | { kind: "connection-remove"; connection: AliasProviderConnection }
    | { kind: "provider-operation"; value: AliasProviderOperation }
    | { kind: "provider-dispatched"; operationId: string }
    | { kind: "provider-ack"; operationId: string; snapshot?: AliasProviderSnapshot }
    | { kind: "provider-unknown"; operationId: string }
    | { kind: "provider-failed"; operationId: string; reason: AliasProviderFailureReason }
    | { kind: "provider-observe"; snapshot: AliasProviderSnapshot }
    | {
        kind: "reference-set";
        cipherId: string;
        expectedAliasKey: string | null;
        alias: EmailAliasIdentity;
      }
    | { kind: "reference-clear"; cipherId: string; expectedAliasKey: string | null }
    | { kind: "conflict-resolve"; conflictId: string; chosenEventId: string }
  );

export type AliasProviderFailureReason =
  "invalid-credentials" | "forbidden" | "not-found" | "rate-limited" | "invalid-response";

export type AliasSyncEventInput = AliasSyncEvent extends infer Event
  ? Event extends AliasSyncEvent
    ? Omit<Event, keyof AliasSyncEventBase>
    : never
  : never;

export type AliasSyncDocument = {
  version: typeof ALIAS_SYNC_VERSION;
  replicaId: string;
  clock: AliasVectorClock;
  events: AliasSyncEvent[];
};

export type AliasSyncConflict = {
  id: string;
  kind:
    | "connection-removed"
    | "provider-state"
    | "alias-identity"
    | "reference-retarget"
    | "reference-precondition"
    | "event-integrity"
    | "provider-outcome-unknown";
  key: string;
  eventIds: string[];
};

export type AliasOperationStatus = "prepared" | "dispatched" | "unknown" | "applied" | "failed";

export type AliasProjectedOperation = {
  event: Extract<AliasSyncEvent, { kind: "provider-operation" }>;
  status: AliasOperationStatus;
  snapshot?: AliasProviderSnapshot;
  failure?: AliasProviderFailureReason;
};

export type AliasProjectedConnection = {
  connection: AliasProviderConnection;
  status: "active" | "removed";
};

export type AliasProjectedAlias = {
  identity: EmailAliasIdentity;
  status: "enabled" | "disabled" | "deleted";
  fields: AliasProviderPatch;
};

export type AliasProjectedReference = {
  cipherId: string;
  alias?: EmailAliasIdentity;
  conflicted: boolean;
};

export type AliasSyncProjection = {
  connections: Record<string, AliasProjectedConnection>;
  aliases: Record<string, AliasProjectedAlias>;
  references: Record<string, AliasProjectedReference>;
  operations: Record<string, AliasProjectedOperation>;
  conflicts: AliasSyncConflict[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_SECRET_KEYS = new Set([
  "authentication",
  "api_key",
  "api_token",
  "apikey",
  "apitoken",
  "password",
  "signed_suffix",
  "signedsuffix",
  "token",
]);
const PROVIDER_FAILURE_REASONS = new Set<AliasProviderFailureReason>([
  "invalid-credentials",
  "forbidden",
  "not-found",
  "rate-limited",
  "invalid-response",
]);

function uuid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) {
    throw new Error(`Invalid alias sync ${field}`);
  }
}

function canonicalProviderInstance(value: string): string {
  const url = new URL(value);
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid alias provider instance");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) {
    throw new Error("Invalid alias provider instance");
  }
  url.pathname = url.pathname.replace(/\/*$/, "/");
  return url.toString();
}

function sanitizeConnection(value: AliasProviderConnection): AliasProviderConnection {
  if (!value || value.provider !== "simplelogin") {
    throw new Error("Invalid alias provider connection");
  }
  assertUuid(value.connectionId, "connection id");
  return {
    provider: "simplelogin",
    providerInstance: canonicalProviderInstance(value.providerInstance),
    connectionId: value.connectionId.toLowerCase(),
  };
}

function sanitizeIdentity(value: EmailAliasIdentity): EmailAliasIdentity {
  const parsed = parseEmailAliasIdentity(value);
  if (!parsed) {
    throw new Error("Invalid alias identity in sync event");
  }
  return parsed;
}

function assertNoCredentialMaterial(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    throw new Error("Alias sync events must be acyclic");
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_KEYS.has(key.replaceAll("-", "").toLowerCase())) {
      throw new Error("Provider credentials cannot be written to the alias sync journal");
    }
    assertNoCredentialMaterial(child, seen);
  }
  seen.delete(value);
}

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function sanitizeClock(value: AliasVectorClock): AliasVectorClock {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid alias vector clock");
  }
  const clock: AliasVectorClock = {};
  for (const [replicaId, counter] of Object.entries(value)) {
    assertUuid(replicaId, "clock replica id");
    if (!Number.isSafeInteger(counter) || counter < 0) {
      throw new Error("Invalid alias vector counter");
    }
    if (counter > 0) {
      clock[replicaId.toLowerCase()] = counter;
    }
  }
  return clock;
}

function operationConnection(operation: AliasProviderOperation): AliasProviderConnection {
  if (operation.operation === "create") {
    return sanitizeConnection(operation.connection);
  }
  const alias = sanitizeIdentity(operation.alias);
  return {
    provider: alias.provider,
    providerInstance: alias.providerInstance,
    connectionId: alias.connectionId,
  };
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid alias sync ${field}`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid alias sync ${field}`);
  }
  return value;
}

function sanitizePatch(value: unknown): AliasProviderPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid alias provider patch");
  }
  const candidate = value as AliasProviderPatch;
  const patch: AliasProviderPatch = {};
  for (const field of ["name", "note"] as const) {
    if (candidate[field] !== undefined) {
      if (candidate[field] !== null && typeof candidate[field] !== "string") {
        throw new Error(`Invalid alias provider ${field}`);
      }
      patch[field] = candidate[field];
    }
  }
  if (candidate.mailboxIds !== undefined) {
    if (
      !Array.isArray(candidate.mailboxIds) ||
      candidate.mailboxIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
    ) {
      throw new Error("Invalid alias provider mailbox ids");
    }
    patch.mailboxIds = [...candidate.mailboxIds];
  }
  for (const field of ["pgpDisabled", "pinned"] as const) {
    if (candidate[field] !== undefined) {
      if (typeof candidate[field] !== "boolean") {
        throw new Error(`Invalid alias provider ${field}`);
      }
      patch[field] = candidate[field];
    }
  }
  return patch;
}

function sanitizeSnapshot(value: unknown): AliasProviderSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid alias provider snapshot");
  }
  const candidate = value as AliasProviderSnapshot;
  if (typeof candidate.enabled !== "boolean") {
    throw new Error("Invalid alias provider state");
  }
  return {
    alias: sanitizeIdentity(candidate.alias),
    enabled: candidate.enabled,
    ...sanitizePatch(candidate),
  };
}

function sanitizeOperation(value: unknown): AliasProviderOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid alias provider operation");
  }
  const candidate = value as AliasProviderOperation;
  switch (candidate.operation) {
    case "create": {
      const connection = sanitizeConnection(candidate.connection);
      const request = candidate.request;
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        throw new Error("Invalid alias create request");
      }
      if (request.kind === "random") {
        if (request.mode !== undefined && request.mode !== "uuid" && request.mode !== "word") {
          throw new Error("Invalid alias random mode");
        }
        return {
          operation: "create",
          connection,
          request: {
            kind: "random",
            hostname: optionalString(request.hostname, "hostname"),
            mode: request.mode,
            note: optionalString(request.note, "note"),
          },
        };
      }
      if (request.kind === "custom") {
        return {
          operation: "create",
          connection,
          request: {
            kind: "custom",
            hostname: optionalString(request.hostname, "hostname"),
            requestFingerprint: nonEmptyString(request.requestFingerprint, "request fingerprint"),
          },
        };
      }
      throw new Error("Invalid alias create request kind");
    }
    case "update":
      return {
        operation: "update",
        alias: sanitizeIdentity(candidate.alias),
        patch: sanitizePatch(candidate.patch),
      };
    case "enable":
    case "disable":
    case "delete":
      return { operation: candidate.operation, alias: sanitizeIdentity(candidate.alias) };
    default:
      throw new Error("Invalid alias provider operation kind");
  }
}

function sanitizeInput(input: AliasSyncEventInput): AliasSyncEventInput {
  assertNoCredentialMaterial(input);
  switch (input.kind) {
    case "connection-upsert":
    case "connection-remove":
      return { kind: input.kind, connection: sanitizeConnection(input.connection) };
    case "provider-operation":
      return { kind: "provider-operation", value: sanitizeOperation(input.value) };
    case "provider-dispatched":
    case "provider-unknown":
      assertUuid(input.operationId, "operation id");
      return { kind: input.kind, operationId: input.operationId.toLowerCase() };
    case "provider-ack":
      assertUuid(input.operationId, "operation id");
      return {
        kind: "provider-ack",
        operationId: input.operationId.toLowerCase(),
        snapshot: input.snapshot ? sanitizeSnapshot(input.snapshot) : undefined,
      };
    case "provider-failed":
      assertUuid(input.operationId, "operation id");
      if (!PROVIDER_FAILURE_REASONS.has(input.reason)) {
        throw new Error("Invalid alias provider failure reason");
      }
      return {
        kind: "provider-failed",
        operationId: input.operationId.toLowerCase(),
        reason: input.reason,
      };
    case "provider-observe":
      return { kind: "provider-observe", snapshot: sanitizeSnapshot(input.snapshot) };
    case "reference-set":
      return {
        kind: "reference-set",
        cipherId: nonEmptyString(input.cipherId, "cipher id"),
        expectedAliasKey:
          input.expectedAliasKey === null
            ? null
            : nonEmptyString(input.expectedAliasKey, "reference precondition"),
        alias: sanitizeIdentity(input.alias),
      };
    case "reference-clear":
      return {
        kind: "reference-clear",
        cipherId: nonEmptyString(input.cipherId, "cipher id"),
        expectedAliasKey:
          input.expectedAliasKey === null
            ? null
            : nonEmptyString(input.expectedAliasKey, "reference precondition"),
      };
    case "conflict-resolve":
      assertUuid(input.chosenEventId, "chosen event id");
      return {
        kind: "conflict-resolve",
        conflictId: nonEmptyString(input.conflictId, "conflict id"),
        chosenEventId: input.chosenEventId.toLowerCase(),
      };
    default:
      throw new Error("Unsupported alias sync event kind");
  }
}

export function createAliasSyncDocument(replicaId = uuid()): AliasSyncDocument {
  assertUuid(replicaId, "replica id");
  const normalized = replicaId.toLowerCase();
  return { version: ALIAS_SYNC_VERSION, replicaId: normalized, clock: {}, events: [] };
}

export function appendAliasSyncEvent(
  document: AliasSyncDocument,
  input: AliasSyncEventInput,
  eventId = uuid(),
): AliasSyncDocument {
  const parsed = parseAliasSyncDocument(document);
  assertUuid(eventId, "event id");
  const id = eventId.toLowerCase();
  if (parsed.events.some((event) => event.id === id)) {
    throw new Error("Duplicate alias sync event id");
  }
  const clock = mergeAliasVectorClocks(parsed.clock);
  clock[parsed.replicaId] = (clock[parsed.replicaId] ?? 0) + 1;
  const event = {
    version: ALIAS_SYNC_VERSION,
    id,
    replicaId: parsed.replicaId,
    clock,
    ...sanitizeInput(input),
  } as AliasSyncEvent;
  return { ...parsed, clock, events: [...parsed.events, event] };
}

export function mergeAliasVectorClocks(...clocks: AliasVectorClock[]): AliasVectorClock {
  const merged: AliasVectorClock = {};
  for (const source of clocks) {
    for (const [replicaId, counter] of Object.entries(sanitizeClock(source))) {
      merged[replicaId] = Math.max(merged[replicaId] ?? 0, counter);
    }
  }
  return merged;
}

export function compareAliasVectorClocks(
  left: AliasVectorClock,
  right: AliasVectorClock,
): "before" | "after" | "equal" | "concurrent" {
  let leftGreater = false;
  let rightGreater = false;
  const replicas = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const replica of replicas) {
    const leftCounter = left[replica] ?? 0;
    const rightCounter = right[replica] ?? 0;
    leftGreater ||= leftCounter > rightCounter;
    rightGreater ||= rightCounter > leftCounter;
  }
  if (leftGreater && rightGreater) {
    return "concurrent";
  }
  if (leftGreater) {
    return "after";
  }
  if (rightGreater) {
    return "before";
  }
  return "equal";
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sanitizeEvent(value: AliasSyncEvent): AliasSyncEvent {
  if (!value || value.version !== ALIAS_SYNC_VERSION) {
    throw new Error("Unsupported alias sync event version");
  }
  assertUuid(value.id, "event id");
  assertUuid(value.replicaId, "event replica id");
  const clock = sanitizeClock(value.clock);
  const replicaId = value.replicaId.toLowerCase();
  if ((clock[replicaId] ?? 0) < 1) {
    throw new Error("Alias sync event clock does not include its replica");
  }
  const input = cloneJson(value) as unknown as Record<string, unknown>;
  delete input.version;
  delete input.id;
  delete input.replicaId;
  delete input.clock;
  return {
    version: ALIAS_SYNC_VERSION,
    id: value.id.toLowerCase(),
    replicaId,
    clock,
    ...sanitizeInput(input as AliasSyncEventInput),
  } as AliasSyncEvent;
}

export function parseAliasSyncDocument(value: unknown): AliasSyncDocument {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid alias sync document");
  }
  const candidate = value as Partial<AliasSyncDocument>;
  if (candidate.version !== ALIAS_SYNC_VERSION || !Array.isArray(candidate.events)) {
    throw new Error("Unsupported alias sync document version");
  }
  assertUuid(candidate.replicaId ?? "", "replica id");
  const replicaId = candidate.replicaId!.toLowerCase();
  const clock = sanitizeClock(candidate.clock ?? {});
  const events = candidate.events.map(sanitizeEvent);
  const ids = new Set<string>();
  for (const event of events) {
    if (ids.has(event.id)) {
      throw new Error("Duplicate alias sync event id");
    }
    ids.add(event.id);
    for (const [eventReplica, counter] of Object.entries(event.clock)) {
      if ((clock[eventReplica] ?? 0) < counter) {
        throw new Error("Alias sync document clock is older than an event");
      }
    }
  }
  return { version: ALIAS_SYNC_VERSION, replicaId, clock, events };
}

export function mergeAliasSyncDocuments(
  local: AliasSyncDocument,
  ...remotes: AliasSyncDocument[]
): AliasSyncDocument {
  const parsedLocal = parseAliasSyncDocument(local);
  const documents = [parsedLocal, ...remotes.map(parseAliasSyncDocument)];
  const events = new Map<string, AliasSyncEvent>();
  for (const document of documents) {
    for (const event of document.events) {
      const current = events.get(event.id);
      if (current && stable(current) !== stable(event)) {
        throw new Error("Alias sync event id has conflicting content");
      }
      events.set(event.id, event);
    }
  }
  return {
    version: ALIAS_SYNC_VERSION,
    replicaId: parsedLocal.replicaId,
    clock: mergeAliasVectorClocks(...documents.map((document) => document.clock)),
    events: [...events.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function aliasConnectionKey(connection: AliasProviderConnection): string {
  const parsed = sanitizeConnection(connection);
  return `${parsed.provider}\n${parsed.providerInstance}\n${parsed.connectionId}`;
}

export function emailAliasKey(identity: EmailAliasIdentity): string {
  const parsed = sanitizeIdentity(identity);
  return `${aliasConnectionKey({
    provider: parsed.provider,
    providerInstance: parsed.providerInstance,
    connectionId: parsed.connectionId,
  })}\n${parsed.aliasId}`;
}

function maximal<Event extends AliasSyncEvent>(events: Event[]): Event[] {
  return events.filter(
    (candidate) =>
      !events.some(
        (other) =>
          other.id !== candidate.id &&
          compareAliasVectorClocks(candidate.clock, other.clock) === "before",
      ),
  );
}

function resolvedEventIds(events: AliasSyncEvent[]): Map<string, string> {
  const resolutions = new Map<string, Extract<AliasSyncEvent, { kind: "conflict-resolve" }>[]>();
  for (const event of events) {
    if (event.kind !== "conflict-resolve") {
      continue;
    }
    resolutions.set(event.conflictId, [...(resolutions.get(event.conflictId) ?? []), event]);
  }
  const chosen = new Map<string, string>();
  for (const [id, candidates] of resolutions) {
    const winners = maximal(candidates);
    const choices = new Set(winners.map((event) => event.chosenEventId));
    if (choices.size === 1) {
      chosen.set(id, choices.values().next().value!);
    }
  }
  return chosen;
}

function conflict(
  kind: AliasSyncConflict["kind"],
  key: string,
  events: AliasSyncEvent[],
): AliasSyncConflict {
  const eventIds = events.map((event) => event.id).sort();
  return { id: `${kind}:${key}:${eventIds.join(",")}`, kind, key, eventIds };
}

function providerSnapshotFromOperation(
  operation: AliasProviderOperation,
): Partial<AliasProviderSnapshot> | undefined {
  if (operation.operation === "create") {
    return undefined;
  }
  switch (operation.operation) {
    case "update":
      return { alias: operation.alias, ...operation.patch };
    case "enable":
      return { alias: operation.alias, enabled: true };
    case "disable":
      return { alias: operation.alias, enabled: false };
    case "delete":
      return { alias: operation.alias };
  }
}

function eventSnapshot(event: AliasSyncEvent): Partial<AliasProviderSnapshot> | undefined {
  if (event.kind === "provider-operation") {
    return providerSnapshotFromOperation(event.value);
  }
  if (event.kind === "provider-ack" || event.kind === "provider-observe") {
    return event.snapshot;
  }
  return undefined;
}

export function projectAliasSync(document: AliasSyncDocument): AliasSyncProjection {
  const parsed = parseAliasSyncDocument(document);
  const conflicts: AliasSyncConflict[] = [];
  const resolved = resolvedEventIds(parsed.events);
  const connections: Record<string, AliasProjectedConnection> = {};
  const aliases: Record<string, AliasProjectedAlias> = {};
  const references: Record<string, AliasProjectedReference> = {};
  const operations: Record<string, AliasProjectedOperation> = {};

  const resolutionGroups = new Map<
    string,
    Extract<AliasSyncEvent, { kind: "conflict-resolve" }>[]
  >();
  for (const event of parsed.events) {
    if (event.kind === "conflict-resolve") {
      resolutionGroups.set(event.conflictId, [
        ...(resolutionGroups.get(event.conflictId) ?? []),
        event,
      ]);
    }
  }
  for (const [conflictId, events] of resolutionGroups) {
    const winners = maximal(events);
    if (new Set(winners.map((event) => event.chosenEventId)).size > 1) {
      const candidate = conflict("event-integrity", conflictId, winners);
      if (!resolved.has(candidate.id)) {
        conflicts.push(candidate);
      }
    }
  }

  const connectionEvents = new Map<string, AliasSyncEvent[]>();
  for (const event of parsed.events) {
    let connection: AliasProviderConnection | undefined;
    if (event.kind === "connection-upsert" || event.kind === "connection-remove") {
      connection = event.connection;
    } else if (event.kind === "provider-operation") {
      connection = operationConnection(event.value);
    } else {
      const snapshot = eventSnapshot(event);
      if (snapshot?.alias) {
        connection = {
          provider: snapshot.alias.provider,
          providerInstance: snapshot.alias.providerInstance,
          connectionId: snapshot.alias.connectionId,
        };
      }
    }
    if (connection) {
      const key = aliasConnectionKey(connection);
      connectionEvents.set(key, [...(connectionEvents.get(key) ?? []), event]);
      connections[key] ??= { connection: sanitizeConnection(connection), status: "active" };
    }
  }
  for (const [key, events] of connectionEvents) {
    const removals = events.filter((event) => event.kind === "connection-remove");
    if (removals.length > 0) {
      connections[key].status = "removed";
      const stale = events.filter(
        (event) =>
          event.kind !== "connection-remove" &&
          removals.some(
            (removal) => compareAliasVectorClocks(removal.clock, event.clock) !== "before",
          ),
      );
      if (stale.length > 0) {
        const candidate = conflict("connection-removed", key, [...removals, ...stale]);
        if (!resolved.has(candidate.id)) {
          conflicts.push(candidate);
        }
      }
    }
  }

  const operationEvents = new Map<string, AliasSyncEvent[]>();
  for (const event of parsed.events) {
    if (event.kind === "provider-operation") {
      operations[event.id] = { event, status: "prepared" };
      operationEvents.set(event.id, [...(operationEvents.get(event.id) ?? []), event]);
    } else if (
      event.kind === "provider-dispatched" ||
      event.kind === "provider-ack" ||
      event.kind === "provider-unknown" ||
      event.kind === "provider-failed"
    ) {
      operationEvents.set(event.operationId, [
        ...(operationEvents.get(event.operationId) ?? []),
        event,
      ]);
    }
  }
  for (const [operationId, events] of operationEvents) {
    const operation = operations[operationId];
    if (!operation) {
      continue;
    }
    const stages = maximal(events.filter((event) => event.id !== operationId));
    const ack = stages.find(
      (event): event is Extract<AliasSyncEvent, { kind: "provider-ack" }> =>
        event.kind === "provider-ack",
    );
    const failed = stages.find(
      (event): event is Extract<AliasSyncEvent, { kind: "provider-failed" }> =>
        event.kind === "provider-failed",
    );
    const unknown = stages.find((event) => event.kind === "provider-unknown");
    const dispatched = stages.find((event) => event.kind === "provider-dispatched");
    if (ack) {
      operation.status = "applied";
      operation.snapshot = ack.snapshot;
    } else if (failed) {
      operation.status = "failed";
      operation.failure = failed.reason;
    } else if (unknown) {
      operation.status = "unknown";
      conflicts.push(conflict("provider-outcome-unknown", operationId, [operation.event, unknown]));
    } else if (dispatched) {
      operation.status = "dispatched";
    }
  }

  const aliasEvents = new Map<string, AliasSyncEvent[]>();
  for (const event of parsed.events) {
    if (event.kind === "provider-operation" && operations[event.id]?.status === "failed") {
      continue;
    }
    const snapshot = eventSnapshot(event);
    if (!snapshot?.alias) {
      continue;
    }
    const key = emailAliasKey(snapshot.alias);
    aliasEvents.set(key, [...(aliasEvents.get(key) ?? []), event]);
  }
  for (const [key, events] of aliasEvents) {
    const identities = new Map<
      string,
      { identity: EmailAliasIdentity; events: AliasSyncEvent[] }
    >();
    for (const event of events) {
      const identity = eventSnapshot(event)?.alias;
      if (!identity) {
        continue;
      }
      const address = identity.address.trim().toLowerCase();
      const entry = identities.get(address) ?? { identity, events: [] };
      entry.events.push(event);
      identities.set(address, entry);
    }
    const identityEntries = [...identities.values()].sort((left, right) =>
      left.identity.address.localeCompare(right.identity.address),
    );
    let identity = identityEntries[0]?.identity;
    if (!identity) {
      continue;
    }
    if (identityEntries.length > 1) {
      const identityEvents = identityEntries.flatMap((entry) => entry.events);
      const candidate = conflict("alias-identity", key, identityEvents);
      const chosen = resolved.get(candidate.id);
      const chosenIdentity = identityEvents.find((event) => event.id === chosen);
      if (chosenIdentity) {
        identity = eventSnapshot(chosenIdentity)?.alias ?? identity;
      } else {
        conflicts.push(candidate);
      }
    }
    const deletes = events.filter(
      (event) => event.kind === "provider-operation" && event.value.operation === "delete",
    );
    let status: AliasProjectedAlias["status"] = "enabled";
    const fields: AliasProviderPatch = {};
    if (deletes.length > 0) {
      status = "deleted";
      const competing = events.filter(
        (event) =>
          !deletes.includes(event) &&
          deletes.some(
            (deletion) => compareAliasVectorClocks(deletion.clock, event.clock) !== "before",
          ),
      );
      if (competing.length > 0) {
        const candidate = conflict("provider-state", key, [...deletes, ...competing]);
        if (!resolved.has(candidate.id)) {
          conflicts.push(candidate);
        }
      }
    } else {
      const stateEvents = maximal(
        events.filter((event) => {
          const snapshot = eventSnapshot(event);
          return snapshot?.enabled !== undefined;
        }),
      );
      const states = new Set(stateEvents.map((event) => eventSnapshot(event)?.enabled));
      if (states.size > 1) {
        const candidate = conflict("provider-state", key, stateEvents);
        const chosen = resolved.get(candidate.id);
        if (!chosen) {
          conflicts.push(candidate);
        }
        const winner =
          stateEvents.find((event) => event.id === chosen) ??
          [...stateEvents].sort((left, right) => left.id.localeCompare(right.id))[0];
        status = eventSnapshot(winner)?.enabled === false ? "disabled" : "enabled";
      } else if (stateEvents[0]) {
        status = eventSnapshot(stateEvents[0])?.enabled === false ? "disabled" : "enabled";
      }
      for (const field of ["name", "note", "mailboxIds", "pgpDisabled", "pinned"] as const) {
        const fieldEvents = maximal(
          events.filter((event) => eventSnapshot(event)?.[field] !== undefined),
        );
        if (fieldEvents.length === 0) {
          continue;
        }
        const values = new Set(fieldEvents.map((event) => stable(eventSnapshot(event)?.[field])));
        if (values.size > 1) {
          const candidate = conflict("provider-state", `${key}:${field}`, fieldEvents);
          const chosen = resolved.get(candidate.id);
          if (!chosen) {
            conflicts.push(candidate);
          }
          const winner =
            fieldEvents.find((event) => event.id === chosen) ??
            [...fieldEvents].sort((left, right) => left.id.localeCompare(right.id))[0];
          (fields as Record<string, unknown>)[field] = eventSnapshot(winner)?.[field];
        } else {
          (fields as Record<string, unknown>)[field] = eventSnapshot(fieldEvents[0])?.[field];
        }
      }
    }
    aliases[key] = { identity, status, fields };
  }

  type ReferenceEvent = Extract<AliasSyncEvent, { kind: "reference-set" | "reference-clear" }>;
  const referenceEvents = new Map<string, ReferenceEvent[]>();
  for (const event of parsed.events) {
    if (event.kind === "reference-set" || event.kind === "reference-clear") {
      referenceEvents.set(event.cipherId, [...(referenceEvents.get(event.cipherId) ?? []), event]);
    }
  }
  for (const [cipherId, events] of referenceEvents) {
    // Validate compare-and-set preconditions against the causally preceding journal state. An
    // event from a stale snapshot is retained for conflict reporting but cannot become the value.
    const valid: ReferenceEvent[] = [];
    const ordered = [...events].sort((left, right) => {
      const leftTicks = Object.values(left.clock).reduce((sum, value) => sum + value, 0);
      const rightTicks = Object.values(right.clock).reduce((sum, value) => sum + value, 0);
      return leftTicks - rightTicks || left.id.localeCompare(right.id);
    });
    for (const event of ordered) {
      const predecessors = maximal(
        valid.filter(
          (candidate) => compareAliasVectorClocks(candidate.clock, event.clock) === "before",
        ),
      );
      if (predecessors.length === 0) {
        // The first journal event may be based on an existing schema-v1 cipher reference.
        valid.push(event);
        continue;
      }
      const predecessorTargets = new Set(
        predecessors.map((candidate) =>
          candidate.kind === "reference-set" ? emailAliasKey(candidate.alias) : null,
        ),
      );
      let predecessorTarget: string | null | undefined;
      if (predecessorTargets.size === 1) {
        predecessorTarget = predecessorTargets.values().next().value;
      } else {
        const priorConflict = conflict("reference-retarget", cipherId, predecessors);
        const chosen = resolved.get(priorConflict.id);
        const chosenEvent = predecessors.find((candidate) => candidate.id === chosen);
        if (chosenEvent) {
          predecessorTarget =
            chosenEvent.kind === "reference-set" ? emailAliasKey(chosenEvent.alias) : null;
        }
      }
      if (predecessorTarget === undefined || event.expectedAliasKey !== predecessorTarget) {
        const candidate = conflict("reference-precondition", cipherId, [...predecessors, event]);
        const chosen = resolved.get(candidate.id);
        if (!chosen) {
          conflicts.push(candidate);
        }
        if (chosen === event.id) {
          valid.push(event);
        }
        continue;
      }
      valid.push(event);
    }

    const candidates = maximal(valid);
    const candidateTargets = new Set(
      candidates.map((event) =>
        event.kind === "reference-set" ? emailAliasKey(event.alias) : null,
      ),
    );
    const expected = new Set(candidates.map((event) => event.expectedAliasKey));
    let chosen: AliasSyncEvent | undefined;
    let conflicted = false;
    if (candidateTargets.size > 1) {
      const clear = candidates.find((event) => event.kind === "reference-clear");
      const candidate = conflict("reference-retarget", cipherId, candidates);
      const resolution = resolved.get(candidate.id);
      chosen = candidates.find((event) => event.id === resolution) ?? clear;
      if (!resolution) {
        conflicts.push(candidate);
        conflicted = true;
      }
    } else {
      chosen = candidates[0];
    }
    if (expected.size > 1) {
      const candidate = conflict("reference-precondition", cipherId, candidates);
      if (!resolved.has(candidate.id)) {
        conflicts.push(candidate);
        conflicted = true;
      }
    }
    references[cipherId] = {
      cipherId,
      alias: chosen?.kind === "reference-set" && !conflicted ? chosen.alias : undefined,
      conflicted,
    };
  }

  const unique = new Map(conflicts.map((entry) => [entry.id, entry]));
  return {
    connections,
    aliases,
    references,
    operations,
    conflicts: [...unique.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function pendingAliasOperations(document: AliasSyncDocument): AliasProjectedOperation[] {
  return Object.values(projectAliasSync(document).operations).filter(
    (operation) => operation.status === "prepared" || operation.status === "dispatched",
  );
}

export interface AliasSyncStore {
  load(): Promise<AliasSyncDocument>;
  save(document: AliasSyncDocument): Promise<void>;
}
