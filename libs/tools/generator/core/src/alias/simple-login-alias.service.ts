import {
  Alias,
  AliasClient,
  AliasClientSettings,
  AliasFilter,
  AliasPage,
  AliasProviderIdentity,
  AliasReference,
  AliasUpdateRequest,
  OptionalSensitiveStringUpdate,
  ReverseAlias,
  SensitiveString,
  parse_alias_reference,
} from "@bitwarden/alias-sdk-internal";
import {
  AliasProjectedOperation,
  AliasProjectedReferenceTransaction,
  AliasProviderOperation,
  AliasProviderSnapshot,
  AliasSyncDocument,
  AliasSyncEventInput,
  AliasSyncProjection,
  AliasSyncStore,
  EmailAliasIdentity,
  aliasConnectionKey,
  appendAliasSyncEvent,
  emailAliasKey,
  normalizeEmailAliasAddress,
  pendingAliasReferenceTransactions,
  parseEmailAliasIdentity,
  projectAliasSync,
} from "@bitwarden/common/tools/alias";

import { SimpleLoginAliasError, normalizeSimpleLoginAliasError } from "./simple-login-alias.error";
import {
  CreateSimpleLoginAliasRequest,
  SimpleLoginAlias,
  SimpleLoginAliasDomain,
  SimpleLoginAliasFilter,
  SimpleLoginAliasPage,
  SimpleLoginAliasRecommendation,
  SimpleLoginAliasSettings,
  SimpleLoginContact,
  SimpleLoginContactPage,
  UpdateSimpleLoginAliasRequest,
} from "./simple-login-alias.types";

const DEFAULT_SIMPLELOGIN_BASE_URL = "https://app.simplelogin.io";
const SIMPLELOGIN_PAGE_SIZE = 20;

const sensitive = (value: string): SensitiveString => value as SensitiveString;

function emailAliasIdentityFromReference(reference: AliasReference): EmailAliasIdentity {
  const identity = parseEmailAliasIdentity({
    version: reference.version,
    provider: reference.provider,
    providerInstance: reference.providerInstance,
    connectionId: reference.connectionId,
    aliasId: reference.aliasId.toString(),
    address: reference.address as string,
  });
  if (!identity) {
    throw new SimpleLoginAliasError(
      "The alias SDK returned an unsupported reference schema",
      "invalid-response",
    );
  }
  return identity;
}

function safeNumber(value: bigint, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new SimpleLoginAliasError(`SimpleLogin returned an invalid ${field}`, "invalid-response");
  }
  return number;
}

function positiveId(value: number, field: string): bigint {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SimpleLoginAliasError(`SimpleLogin ${field} is invalid`, "invalid-response");
  }
  return BigInt(value);
}

function positiveBigInt(value: bigint, field: string): bigint {
  if (value <= 0) {
    throw new SimpleLoginAliasError(`SimpleLogin ${field} is invalid`, "invalid-response");
  }
  return value;
}

function pageNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SimpleLoginAliasError("SimpleLogin page is invalid", "invalid-response");
  }
  return value;
}

function normalizedHostname(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    return new URL(value).hostname || value.trim();
  } catch {
    return value.trim();
  }
}

function filterValue(filter: SimpleLoginAliasFilter): AliasFilter | undefined {
  switch (filter) {
    case "enabled":
      return "Enabled";
    case "disabled":
      return "Disabled";
    case "pinned":
      return "Pinned";
    default:
      return undefined;
  }
}

function optionalTextUpdate(
  value: string | null | undefined,
): OptionalSensitiveStringUpdate | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === null ? { type: "clear" } : { type: "set", value: sensitive(value) };
}

/** UI model mapping from the canonical SDK lifecycle model. */
function simpleLoginAliasFromSdk(client: AliasClient, alias: Alias): SimpleLoginAlias {
  const reference = parse_alias_reference(client.create_alias_reference(alias));
  const latest = alias.latest_activity;
  return {
    id: safeNumber(alias.id, "alias id"),
    address: alias.email as string,
    name: (alias.name as string | undefined) ?? null,
    note: (alias.note as string | undefined) ?? null,
    enabled: alias.enabled,
    pinned: alias.pinned === true,
    createdAt: safeNumber(alias.creation_timestamp, "creation timestamp"),
    blockedCount: safeNumber(alias.nb_block, "blocked count"),
    forwardedCount: safeNumber(alias.nb_forward, "forwarded count"),
    repliedCount: safeNumber(alias.nb_reply, "reply count"),
    supportsPgp: alias.support_pgp,
    pgpDisabled: alias.disable_pgp,
    mailboxes: alias.mailboxes.map((mailbox) => ({
      id: safeNumber(mailbox.id, "mailbox id"),
      email: mailbox.email as string,
    })),
    latestActivity: latest
      ? {
          action: latest.action as "forward" | "reply" | "block" | "bounced",
          timestamp: safeNumber(latest.timestamp, "activity timestamp"),
          contact: {
            email: latest.contact.email as string,
            name: (latest.contact.name as string | undefined) ?? null,
            reverseAlias: latest.contact.reverse_alias as string,
          },
        }
      : null,
    identity: emailAliasIdentityFromReference(reference),
  };
}

function simpleLoginContactFromSdk(contact: ReverseAlias): SimpleLoginContact {
  return {
    id: safeNumber(contact.id, "contact id"),
    address: contact.contact as string,
    reverseAlias: contact.reverse_alias as string,
    reverseAliasAddress: contact.reverse_alias_address as string,
    createdAt: safeNumber(contact.creation_timestamp, "contact creation timestamp"),
    lastEmailSentAt:
      contact.last_email_sent_timestamp === undefined
        ? null
        : safeNumber(contact.last_email_sent_timestamp, "last email timestamp"),
    blocked: contact.block_forward,
    existed: contact.existed === true,
  };
}

/** Angular-independent application service backed exclusively by the canonical alias SDK. */
export class SimpleLoginAliasService {
  private recovering?: Promise<void>;

  constructor(
    private readonly settings: AliasClientSettings,
    private readonly syncStore?: AliasSyncStore,
  ) {}

  providerIdentity(): AliasProviderIdentity {
    const client = new AliasClient(this.settings);
    try {
      return client.provider_identity();
    } finally {
      client.free();
    }
  }

  async recommend(website: string): Promise<SimpleLoginAliasRecommendation> {
    await this.recoverProviderOperations();
    return this.safe(async (client) => {
      const hostname = normalizedHostname(website) ?? "";
      const options = await client.get_alias_options(hostname || undefined);
      let alias: SimpleLoginAlias | undefined;
      if (options.recommendation) {
        alias = await this.findByAddress(options.recommendation.alias as string);
      }
      const recommendation = {
        hostname,
        canCreate: options.can_create,
        prefixSuggestion: options.prefix_suggestion,
        suffixes: options.suffixes.map((suffix) => ({
          suffix: suffix.suffix as string,
          signedSuffix: suffix.signed_suffix as string,
          isCustom: suffix.is_custom,
          isPremium: suffix.is_premium,
        })),
        alias,
      };
      if (alias) {
        await this.remember(alias);
      }
      return recommendation;
    });
  }

  async create(request: CreateSimpleLoginAliasRequest = {}): Promise<SimpleLoginAlias> {
    await this.recoverProviderOperations();
    const provider = this.providerIdentity();
    const operation: AliasProviderOperation = {
      operation: "create",
      connection: {
        provider: provider.provider,
        providerInstance: provider.instance,
        connectionId: provider.connectionId,
      },
      request:
        request.kind === "custom"
          ? {
              kind: "custom",
              hostname: normalizedHostname(request.hostname),
              requestFingerprint: [
                request.aliasPrefix,
                [...request.mailboxIds].sort((left, right) => left - right).join(","),
                normalizedHostname(request.hostname) ?? "",
              ].join("\n"),
            }
          : {
              kind: "random",
              hostname: normalizedHostname(request.hostname),
              mode: request.mode,
              note: request.note,
            },
    };
    return this.journalMutation(operation, async () => this.createDirect(request));
  }

  private async createDirect(
    request: CreateSimpleLoginAliasRequest = {},
  ): Promise<SimpleLoginAlias> {
    return this.safe(async (client) => {
      const hostname = normalizedHostname(request.hostname);
      const alias =
        request.kind === "custom"
          ? await client.create_custom_alias({
              alias_prefix: request.aliasPrefix,
              signed_suffix: sensitive(request.signedSuffix),
              mailbox_ids: request.mailboxIds.map((id) => positiveId(id, "mailbox id")),
              hostname: hostname ? sensitive(hostname) : undefined,
              note: request.note === undefined ? undefined : sensitive(request.note),
              name: request.name === undefined ? undefined : sensitive(request.name),
            })
          : await client.create_random_alias({
              hostname: hostname ? sensitive(hostname) : undefined,
              mode: request.mode === "uuid" ? "Uuid" : request.mode === "word" ? "Word" : undefined,
              note: request.note === undefined ? undefined : sensitive(request.note),
            });
      return simpleLoginAliasFromSdk(client, alias);
    });
  }

  async listCanonical(
    page = 0,
    query?: string,
    filter: SimpleLoginAliasFilter = "all",
  ): Promise<AliasPage> {
    return this.safe((client) => {
      const validPage = pageNumber(page);
      return query
        ? client.search_aliases({
            query: sensitive(query),
            page: validPage,
            filter: filterValue(filter),
          })
        : client.list_aliases(validPage, filterValue(filter));
    });
  }

  async list(
    page = 0,
    query?: string,
    filter: SimpleLoginAliasFilter = "all",
  ): Promise<SimpleLoginAliasPage> {
    await this.recoverProviderOperations();
    const result = await this.listCanonical(page, query, filter);
    const items = await this.safe(async (client) =>
      result.aliases.map((alias) => simpleLoginAliasFromSdk(client, alias)),
    );
    await this.remember(...items);
    return { items, page, nextPage: items.length === SIMPLELOGIN_PAGE_SIZE ? page + 1 : undefined };
  }

  async getCanonical(id: bigint): Promise<Alias> {
    return this.safe((client) => client.get_alias(positiveBigInt(id, "alias id")));
  }

  async get(id: number): Promise<SimpleLoginAlias> {
    await this.recoverProviderOperations();
    const alias = await this.getDirect(id);
    await this.remember(alias);
    return alias;
  }

  private async getDirect(id: number): Promise<SimpleLoginAlias> {
    return this.safe(async (client) =>
      simpleLoginAliasFromSdk(client, await client.get_alias(positiveId(id, "alias id"))),
    );
  }

  async update(id: number, update: UpdateSimpleLoginAliasRequest): Promise<SimpleLoginAlias> {
    await this.recoverProviderOperations();
    const identity = await this.identityForId(id);
    return this.journalMutation({ operation: "update", alias: identity, patch: update }, async () =>
      this.updateDirect(id, update),
    );
  }

  private async updateDirect(
    id: number,
    update: UpdateSimpleLoginAliasRequest,
  ): Promise<SimpleLoginAlias> {
    return this.safe(async (client) => {
      const request: AliasUpdateRequest = {
        note: optionalTextUpdate(update.note),
        name: optionalTextUpdate(update.name),
        mailbox_ids: update.mailboxIds?.map((mailboxId) => positiveId(mailboxId, "mailbox id")),
        disable_pgp: update.pgpDisabled,
        pinned: update.pinned,
      };
      return simpleLoginAliasFromSdk(
        client,
        await client.update_alias(positiveId(id, "alias id"), request),
      );
    });
  }

  async setEnabled(id: number, enabled: boolean): Promise<SimpleLoginAlias> {
    await this.recoverProviderOperations();
    const identity = await this.identityForId(id);
    return this.journalMutation(
      { operation: enabled ? "enable" : "disable", alias: identity },
      async () => this.setEnabledDirect(id, enabled),
    );
  }

  private async setEnabledDirect(id: number, enabled: boolean): Promise<SimpleLoginAlias> {
    return this.safe(async (client) => {
      const aliasId = positiveId(id, "alias id");
      await client.set_alias_enabled(aliasId, enabled);
      return simpleLoginAliasFromSdk(client, await client.get_alias(aliasId));
    });
  }

  async delete(id: number): Promise<void> {
    await this.recoverProviderOperations();
    const identity = await this.identityForId(id);
    await this.journalMutation({ operation: "delete", alias: identity }, async () => {
      await this.deleteDirect(id);
    });
  }

  /** Tombstone this connection and erase its credential from every profile as they converge. */
  async removeConnection(): Promise<AliasSyncDocument | undefined> {
    const document = await this.loadJournal();
    if (!document) {
      return undefined;
    }
    const provider = this.providerIdentity();
    return this.record(document, {
      kind: "connection-remove",
      connection: {
        provider: provider.provider,
        providerInstance: provider.instance,
        connectionId: provider.connectionId,
      },
    });
  }

  /** Read the converged, credential-free state and every unresolved user-visible conflict. */
  async synchronizationState(): Promise<AliasSyncProjection | undefined> {
    const document = await this.loadJournal();
    return document ? projectAliasSync(document) : undefined;
  }

  /** Resolve one retained conflict by explicitly selecting one of its causal events. */
  async resolveSynchronizationConflict(
    conflictId: string,
    chosenEventId: string,
  ): Promise<AliasSyncProjection> {
    const document = await this.loadJournal();
    if (!document) {
      throw new SimpleLoginAliasError("Alias synchronization is not configured", "conflict");
    }
    const conflict = projectAliasSync(document).conflicts.find(
      (candidate) => candidate.id === conflictId,
    );
    if (!conflict || !conflict.eventIds.includes(chosenEventId)) {
      throw new SimpleLoginAliasError("The alias conflict selection is stale", "conflict");
    }
    const updated = await this.record(document, {
      kind: "conflict-resolve",
      conflictId,
      chosenEventId,
    });
    return projectAliasSync(updated);
  }

  private async deleteDirect(id: number): Promise<void> {
    await this.safe((client) => client.delete_alias(positiveId(id, "alias id")));
  }

  async domains(): Promise<SimpleLoginAliasDomain[]> {
    return this.safe(async (client) =>
      (await client.list_domains()).map((domain) => ({
        domain: domain.domain as string,
        isCustom: domain.is_custom,
      })),
    );
  }

  async contacts(aliasId: number, page = 0): Promise<SimpleLoginContactPage> {
    return this.safe(async (client) => {
      const result = await client.list_reverse_aliases(
        positiveId(aliasId, "alias id"),
        pageNumber(page),
      );
      const items = result.contacts.map(simpleLoginContactFromSdk);
      return {
        items,
        page,
        nextPage: items.length === SIMPLELOGIN_PAGE_SIZE ? page + 1 : undefined,
      };
    });
  }

  async createReverseAlias(aliasId: number, contact: string): Promise<SimpleLoginContact> {
    return this.safe(async (client) =>
      simpleLoginContactFromSdk(
        await client.create_reverse_alias(positiveId(aliasId, "alias id"), contact),
      ),
    );
  }

  async toggleContactBlocked(contactId: number): Promise<boolean> {
    return this.safe(
      async (client) =>
        (await client.toggle_contact_blocked(positiveId(contactId, "contact id"))).block_forward,
    );
  }

  async deleteContact(contactId: number): Promise<void> {
    await this.safe((client) => client.delete_contact(positiveId(contactId, "contact id")));
  }

  /** Persist an inert compare-and-set intent before the normal vault update path runs. */
  async prepareReference(
    cipherId: string,
    expected: SimpleLoginAlias["identity"] | undefined,
    alias: SimpleLoginAlias["identity"],
  ): Promise<string | undefined> {
    const syncStore = this.syncStore;
    if (!syncStore) {
      return undefined;
    }
    const document = await syncStore.load();
    const updated = appendAliasSyncEvent(document, {
      kind: "reference-prepare",
      cipherId,
      expectedAlias: expected ?? null,
      alias,
    });
    const prepared = updated.events.at(-1);
    if (prepared?.kind !== "reference-prepare") {
      throw new SimpleLoginAliasError(
        "The alias reference transaction was not prepared",
        "conflict",
      );
    }
    await syncStore.save(updated);
    return prepared.id;
  }

  /** Commit an inert reference intent only after vault persistence succeeds. */
  async commitReference(transactionId: string): Promise<void> {
    await this.settleReference(transactionId, "reference-commit", "committed");
  }

  /** Compensate an inert reference intent when vault persistence fails. */
  async abortReference(transactionId: string): Promise<void> {
    await this.settleReference(transactionId, "reference-abort", "aborted");
  }

  /** Return only transactions this replica is authorized to settle after a restart. */
  async pendingReferenceTransactions(): Promise<AliasProjectedReferenceTransaction[]> {
    const document = await this.loadJournal();
    return document ? pendingAliasReferenceTransactions(document) : [];
  }

  private async settleReference(
    transactionId: string,
    kind: "reference-commit" | "reference-abort",
    completedStatus: "committed" | "aborted",
  ): Promise<void> {
    const document = await this.loadJournal();
    if (!document) {
      return;
    }
    const transaction = projectAliasSync(document).referenceTransactions[transactionId];
    if (transaction?.status === completedStatus) {
      return;
    }
    if (
      !transaction ||
      transaction.ownerReplicaId !== document.replicaId ||
      transaction.status !== "pending"
    ) {
      throw new SimpleLoginAliasError("The alias reference transaction is stale", "conflict");
    }
    await this.record(document, { kind, transactionId });
  }

  /** Persist an explicit unbind tombstone so a concurrent stale binding cannot silently return. */
  async clearReference(
    cipherId: string,
    expected: SimpleLoginAlias["identity"] | undefined,
  ): Promise<void> {
    const document = await this.loadJournal();
    if (!document) {
      return;
    }
    await this.record(document, {
      kind: "reference-clear",
      cipherId,
      expectedAliasKey: expected ? emailAliasKey(expected) : null,
    });
  }

  private async findByAddress(address: string): Promise<SimpleLoginAlias | undefined> {
    const result = await this.listDirect(0, address);
    const normalized = normalizeEmailAliasAddress(address);
    return result.items.find((alias) => normalizeEmailAliasAddress(alias.address) === normalized);
  }

  private async listDirect(
    page = 0,
    query?: string,
    filter: SimpleLoginAliasFilter = "all",
  ): Promise<SimpleLoginAliasPage> {
    const result = await this.listCanonical(page, query, filter);
    const items = await this.safe(async (client) =>
      result.aliases.map((alias) => simpleLoginAliasFromSdk(client, alias)),
    );
    return { items, page, nextPage: items.length === SIMPLELOGIN_PAGE_SIZE ? page + 1 : undefined };
  }

  private snapshot(alias: SimpleLoginAlias): AliasProviderSnapshot {
    return {
      alias: alias.identity,
      enabled: alias.enabled,
      name: alias.name,
      note: alias.note,
      mailboxIds: alias.mailboxes.map((mailbox) => mailbox.id),
      pgpDisabled: alias.pgpDisabled,
      pinned: alias.pinned,
    };
  }

  private async loadJournal(): Promise<AliasSyncDocument | undefined> {
    if (!this.syncStore) {
      return undefined;
    }
    return this.syncStore.load();
  }

  private async record(
    document: AliasSyncDocument,
    input: AliasSyncEventInput,
  ): Promise<AliasSyncDocument> {
    if (!this.syncStore) {
      return document;
    }
    const updated = appendAliasSyncEvent(document, input);
    await this.syncStore.save(updated);
    return this.syncStore.load();
  }

  private async remember(...aliases: SimpleLoginAlias[]): Promise<void> {
    let document = await this.loadJournal();
    if (!document) {
      return;
    }
    if (this.connectionWasRemoved(document)) {
      return;
    }
    const projection = projectAliasSync(document);
    for (const alias of aliases) {
      const snapshot = this.snapshot(alias);
      const known = Object.values(projection.aliases).find(
        (candidate) =>
          candidate.identity.provider === alias.identity.provider &&
          candidate.identity.providerInstance === alias.identity.providerInstance &&
          candidate.identity.connectionId === alias.identity.connectionId &&
          candidate.identity.aliasId === alias.identity.aliasId,
      );
      if (
        known?.identity.address === alias.identity.address &&
        known.status === (alias.enabled ? "enabled" : "disabled") &&
        JSON.stringify(known.fields) ===
          JSON.stringify({
            name: snapshot.name,
            note: snapshot.note,
            mailboxIds: snapshot.mailboxIds,
            pgpDisabled: snapshot.pgpDisabled,
            pinned: snapshot.pinned,
          })
      ) {
        continue;
      }
      document = await this.record(document, { kind: "provider-observe", snapshot });
    }
  }

  private async identityForId(id: number) {
    positiveId(id, "alias id");
    const document = await this.loadJournal();
    if (document) {
      const provider = this.providerIdentity();
      const known = Object.values(projectAliasSync(document).aliases).find(
        (candidate) =>
          candidate.identity.provider === provider.provider &&
          candidate.identity.providerInstance === provider.instance &&
          candidate.identity.connectionId === provider.connectionId &&
          candidate.identity.aliasId === String(id) &&
          candidate.status !== "deleted",
      );
      if (known) {
        return known.identity;
      }
    }
    const alias = await this.getDirect(id);
    await this.remember(alias);
    return alias.identity;
  }

  private async journalMutation<Result>(
    operation: AliasProviderOperation,
    mutate: () => Promise<Result>,
  ): Promise<Result> {
    let document = await this.loadJournal();
    if (!document) {
      return mutate();
    }
    if (this.connectionWasRemoved(document)) {
      throw new SimpleLoginAliasError(
        "The SimpleLogin connection was removed on another vault session",
        "conflict",
      );
    }
    const unresolved = projectAliasSync(document).conflicts.find(
      (conflict) => conflict.kind === "provider-state" || conflict.kind === "alias-identity",
    );
    if (unresolved) {
      throw new SimpleLoginAliasError(
        "An alias change conflicts with another vault session and requires resolution",
        "conflict",
      );
    }
    document = await this.record(document, { kind: "provider-operation", value: operation });
    const replicaId = document.replicaId;
    const operationId = document.events
      .filter((event) => event.kind === "provider-operation")
      .sort((left, right) => (left.clock[replicaId] ?? 0) - (right.clock[replicaId] ?? 0))
      .at(-1)!.id;
    document = await this.record(document, { kind: "provider-dispatched", operationId });
    try {
      const result = await mutate();
      const snapshot = this.isSimpleLoginAlias(result) ? this.snapshot(result) : undefined;
      await this.record(document, { kind: "provider-ack", operationId, snapshot });
      return result;
    } catch (error) {
      const normalized = normalizeSimpleLoginAliasError(error);
      if (operation.operation === "delete" && normalized.code === "not-found") {
        await this.record(document, { kind: "provider-ack", operationId });
        return undefined as Result;
      }
      if (normalized.code === "remote-error") {
        await this.record(document, { kind: "provider-unknown", operationId });
      } else {
        await this.record(document, {
          kind: "provider-failed",
          operationId,
          reason: normalized.code === "conflict" ? "invalid-response" : normalized.code,
        });
      }
      throw normalized;
    }
  }

  private isSimpleLoginAlias(value: unknown): value is SimpleLoginAlias {
    return !!value && typeof value === "object" && "identity" in value && "enabled" in value;
  }

  private async recoverProviderOperations(): Promise<void> {
    if (!this.syncStore) {
      return;
    }
    if (this.recovering !== undefined) {
      return this.recovering;
    }
    this.recovering = this.recoverProviderOperationsInternal().finally(() => {
      this.recovering = undefined;
    });
    return this.recovering;
  }

  private async recoverProviderOperationsInternal(): Promise<void> {
    let document = await this.loadJournal();
    if (!document) {
      return;
    }
    const projection = projectAliasSync(document);
    if (this.connectionWasRemoved(document)) {
      return;
    }
    const unsettled = Object.values(projection.operations).filter(
      (operation) =>
        operation.status === "prepared" ||
        operation.status === "dispatched" ||
        operation.status === "unknown",
    );
    for (const pending of unsettled) {
      document = await this.recoverProviderOperation(document, pending);
    }
  }

  private async recoverProviderOperation(
    document: AliasSyncDocument,
    pending: AliasProjectedOperation,
  ): Promise<AliasSyncDocument> {
    const operation = pending.event.value;
    const operationId = pending.event.id;
    if (operation.operation === "create") {
      if (pending.status === "prepared" && operation.request.kind === "random") {
        document = await this.record(document, { kind: "provider-dispatched", operationId });
        const alias = await this.createDirect(operation.request);
        return this.record(document, {
          kind: "provider-ack",
          operationId,
          snapshot: this.snapshot(alias),
        });
      }
      if (pending.status !== "unknown") {
        document = await this.record(document, { kind: "provider-unknown", operationId });
      }
      throw new SimpleLoginAliasError(
        "A SimpleLogin create operation has an unknown outcome and requires reconciliation",
        "conflict",
      );
    }

    const id = Number(operation.alias.aliasId);
    if (operation.operation === "delete") {
      try {
        await this.getDirect(id);
      } catch (error) {
        const normalized = normalizeSimpleLoginAliasError(error);
        if (normalized.code === "not-found") {
          return this.record(document, { kind: "provider-ack", operationId });
        }
        throw normalized;
      }
      await this.deleteDirect(id);
      return this.record(document, { kind: "provider-ack", operationId });
    }

    let observed = await this.getDirect(id);
    const satisfied =
      operation.operation === "enable"
        ? observed.enabled
        : operation.operation === "disable"
          ? !observed.enabled
          : this.patchSatisfied(observed, operation.patch);
    if (!satisfied) {
      observed =
        operation.operation === "update"
          ? await this.updateDirect(id, operation.patch)
          : await this.setEnabledDirect(id, operation.operation === "enable");
    }
    return this.record(document, {
      kind: "provider-ack",
      operationId,
      snapshot: this.snapshot(observed),
    });
  }

  private patchSatisfied(alias: SimpleLoginAlias, patch: UpdateSimpleLoginAliasRequest): boolean {
    return (
      (patch.name === undefined || patch.name === alias.name) &&
      (patch.note === undefined || patch.note === alias.note) &&
      (patch.pgpDisabled === undefined || patch.pgpDisabled === alias.pgpDisabled) &&
      (patch.pinned === undefined || patch.pinned === alias.pinned) &&
      (patch.mailboxIds === undefined ||
        JSON.stringify([...patch.mailboxIds].sort((left, right) => left - right)) ===
          JSON.stringify(
            alias.mailboxes.map((mailbox) => mailbox.id).sort((left, right) => left - right),
          ))
    );
  }

  private connectionWasRemoved(document: AliasSyncDocument): boolean {
    const provider = this.providerIdentity();
    const key = aliasConnectionKey({
      provider: provider.provider,
      providerInstance: provider.instance,
      connectionId: provider.connectionId,
    });
    return projectAliasSync(document).connections[key]?.status === "removed";
  }

  private async safe<Result>(operation: (client: AliasClient) => Promise<Result>): Promise<Result> {
    let client: AliasClient;
    try {
      client = new AliasClient(this.settings);
    } catch (error) {
      throw normalizeSimpleLoginAliasError(error);
    }
    try {
      return await operation(client);
    } catch (error) {
      throw normalizeSimpleLoginAliasError(error);
    } finally {
      client.free();
    }
  }
}

export function createSimpleLoginAliasService(
  settings: SimpleLoginAliasSettings,
): SimpleLoginAliasService {
  try {
    const sdkSettings: AliasClientSettings = {
      base_url: settings.baseUrl?.trim() || DEFAULT_SIMPLELOGIN_BASE_URL,
      api_token: sensitive(settings.token.trim()),
      connection_id: settings.connectionId,
    };
    const client = new AliasClient(sdkSettings);
    client.free();
    return new SimpleLoginAliasService(sdkSettings, settings.syncStore);
  } catch (error) {
    throw normalizeSimpleLoginAliasError(error);
  }
}
