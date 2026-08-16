import {
  Alias,
  AliasClient,
  AliasConnection,
  AliasPage,
  SendReplyIdentity,
  SensitiveString,
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
  pendingAliasReferenceTransactions,
  projectAliasSync,
} from "@bitwarden/common/tools/alias";

import {
  SimpleLoginAliasAdapter,
  validateSimpleLoginRuntimeSettings,
} from "./simple-login-alias.adapter";
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

const sensitive = (value: string): SensitiveString => value as SensitiveString;

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

function pageNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SimpleLoginAliasError("SimpleLogin page is invalid", "invalid-response");
  }
  return value;
}

function pageToken(page: number): string | undefined {
  return page > 0 ? `simplelogin-page:${page}` : undefined;
}

/** Stateful lifecycle owner. Provider transport is private to the injected neutral SDK adapter. */
export class SimpleLoginAliasService {
  private recovering?: Promise<void>;
  private operationTail = Promise.resolve();

  constructor(
    private readonly adapter: SimpleLoginAliasAdapter,
    private readonly syncStore?: AliasSyncStore,
  ) {}

  providerIdentity(): AliasConnection {
    return this.withClientSync((client) => client.connection());
  }

  async recommend(website: string): Promise<SimpleLoginAliasRecommendation> {
    await this.recoverProviderOperations();
    const recommendation = await this.safe(() =>
      this.adapter.options(normalizedHostname(website) ?? ""),
    );
    if (!recommendation.alias) {
      return recommendation;
    }
    const canonical = await this.withClient((client) => client.get(recommendation.alias!.identity));
    const alias = this.detail(canonical);
    await this.remember(alias);
    return { ...recommendation, alias };
  }

  async create(request: CreateSimpleLoginAliasRequest = {}): Promise<SimpleLoginAlias> {
    await this.recoverProviderOperations();
    const operation: AliasProviderOperation = {
      operation: "create",
      connection: { version: 1, connectionId: this.adapter.connection.connectionId },
      request: { hostname: normalizedHostname(request.hostname) },
    };
    return this.journalMutation(operation, async () => {
      const alias = await this.adapter.withCreateIntent(request, () =>
        this.withClient((client) =>
          client.create({
            hostname: normalizedHostname(request.hostname)
              ? sensitive(normalizedHostname(request.hostname)!)
              : undefined,
          }),
        ),
      );
      return this.detail(alias);
    });
  }

  async listCanonical(
    page = 0,
    query?: string,
    filter: SimpleLoginAliasFilter = "all",
  ): Promise<AliasPage> {
    const validPage = pageNumber(page);
    return this.adapter.withListIntent(query, filter, () =>
      this.withClient((client) => client.list({ pageToken: pageToken(validPage) })),
    );
  }

  async list(
    page = 0,
    query?: string,
    filter: SimpleLoginAliasFilter = "all",
  ): Promise<SimpleLoginAliasPage> {
    await this.recoverProviderOperations();
    const result = await this.listCanonical(page, query, filter);
    const items = result.aliases.map((alias) => this.detail(alias));
    await this.remember(...items);
    return { items, page, nextPage: result.nextPageToken ? page + 1 : undefined };
  }

  async getCanonical(aliasId: string): Promise<Alias> {
    const native = await this.safe(() => this.adapter.getNative(aliasId));
    return this.withClient((client) => client.get(native.identity));
  }

  async get(id: number): Promise<SimpleLoginAlias> {
    await this.recoverProviderOperations();
    const alias = this.detail(await this.getCanonical(String(id)));
    await this.remember(alias);
    return alias;
  }

  async update(id: number, update: UpdateSimpleLoginAliasRequest): Promise<SimpleLoginAlias> {
    await this.recoverProviderOperations();
    await this.assertMutationAllowed();
    const identity = await this.identityForId(id);
    await this.safe(() => this.adapter.updateNative(identity, update));
    const alias = this.detail(await this.withClient((client) => client.get(identity)));
    await this.remember(alias);
    return alias;
  }

  async setEnabled(id: number, enabled: boolean): Promise<SimpleLoginAlias> {
    await this.recoverProviderOperations();
    const identity = await this.identityForId(id);
    return this.journalMutation(
      { operation: enabled ? "enable" : "disable", alias: identity },
      async () =>
        this.detail(await this.withClient((client) => client.set_enabled(identity, enabled))),
    );
  }

  async delete(id: number): Promise<void> {
    await this.recoverProviderOperations();
    const identity = await this.identityForId(id);
    await this.journalMutation({ operation: "delete", alias: identity }, async () => {
      await this.withClient((client) => client.delete(identity));
    });
  }

  async removeConnection(): Promise<AliasSyncDocument | undefined> {
    const document = await this.loadJournal();
    return document
      ? this.record(document, {
          kind: "connection-remove",
          connection: { version: 1, connectionId: this.adapter.connection.connectionId },
        })
      : undefined;
  }

  async synchronizationState(): Promise<AliasSyncProjection | undefined> {
    const document = await this.loadJournal();
    return document ? projectAliasSync(document) : undefined;
  }

  async resolveSynchronizationConflict(
    conflictId: string,
    chosenEventId: string,
  ): Promise<AliasSyncProjection> {
    const document = await this.loadJournal();
    if (!document) {
      throw new SimpleLoginAliasError("Alias synchronization is not configured", "conflict");
    }
    const conflict = projectAliasSync(document).conflicts.find((value) => value.id === conflictId);
    if (!conflict?.eventIds.includes(chosenEventId)) {
      throw new SimpleLoginAliasError("The alias conflict selection is stale", "conflict");
    }
    return projectAliasSync(
      await this.record(document, { kind: "conflict-resolve", conflictId, chosenEventId }),
    );
  }

  async domains(): Promise<SimpleLoginAliasDomain[]> {
    return this.safe(() => this.adapter.domains());
  }

  async contacts(aliasId: number, page = 0): Promise<SimpleLoginContactPage> {
    const validPage = pageNumber(page);
    const identity = await this.identityForId(aliasId);
    const result = await this.withClient((client) =>
      client.list_send_reply_identities(identity, pageToken(validPage)),
    );
    const items = result.identities.map((value) => this.contactDetail(value));
    return { items, page, nextPage: result.nextPageToken ? page + 1 : undefined };
  }

  async createReverseAlias(aliasId: number, contact: string): Promise<SimpleLoginContact> {
    const alias = await this.identityForId(aliasId);
    const identity = await this.withClient((client) =>
      client.create_send_reply_identity({ alias, recipient: sensitive(contact) }),
    );
    return this.contactDetail(identity);
  }

  async toggleContactBlocked(contact: SimpleLoginContact): Promise<boolean> {
    const current = this.contactIdentity(contact);
    const updated = await this.withClient((client) =>
      client.set_send_reply_blocked(current, !current.blocked),
    );
    const detail = this.contactDetail(updated);
    contact.identity = detail.identity;
    contact.blocked = detail.blocked;
    return detail.blocked;
  }

  async deleteContact(contact: SimpleLoginContact): Promise<void> {
    const identity = this.contactIdentity(contact);
    await this.withClient((client) => client.remove_send_reply_identity(identity));
  }

  async prepareReference(
    cipherId: string,
    expected: EmailAliasIdentity | undefined,
    alias: EmailAliasIdentity,
  ): Promise<string | undefined> {
    const document = await this.loadJournal();
    if (!document) {
      return undefined;
    }
    const recorded = await this.recordWithId(document, {
      kind: "reference-prepare",
      cipherId,
      expectedAlias: expected ?? null,
      alias,
    });
    return recorded.eventId;
  }

  async commitReference(transactionId: string): Promise<void> {
    await this.settleReference(transactionId, "reference-commit", "committed");
  }

  async abortReference(transactionId: string): Promise<void> {
    await this.settleReference(transactionId, "reference-abort", "aborted");
  }

  async pendingReferenceTransactions(): Promise<AliasProjectedReferenceTransaction[]> {
    const document = await this.loadJournal();
    return document ? pendingAliasReferenceTransactions(document) : [];
  }

  async clearReference(cipherId: string, expected: EmailAliasIdentity | undefined): Promise<void> {
    const document = await this.loadJournal();
    if (document) {
      await this.record(document, {
        kind: "reference-clear",
        cipherId,
        expectedAliasKey: expected ? emailAliasKey(expected) : null,
      });
    }
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

  private detail(alias: Alias): SimpleLoginAlias {
    const detail = this.adapter.detail(alias.identity);
    if (
      !detail ||
      (alias.lifecycle === "enabled") !== detail.enabled ||
      alias.lifecycle === "deleted"
    ) {
      throw new SimpleLoginAliasError(
        "SimpleLogin returned an invalid alias snapshot",
        "invalid-response",
      );
    }
    return detail;
  }

  private contactDetail(identity: SendReplyIdentity): SimpleLoginContact {
    const detail = this.adapter.contactDetail(identity.identityId);
    if (
      !detail ||
      detail.address !== (identity.recipient as string) ||
      detail.reverseAliasAddress !== (identity.address as string) ||
      detail.blocked !== identity.blocked
    ) {
      throw new SimpleLoginAliasError(
        "SimpleLogin returned an invalid contact snapshot",
        "invalid-response",
      );
    }
    return { ...detail, identity };
  }

  private contactIdentity(contact: SimpleLoginContact): SendReplyIdentity {
    const identity = contact.identity;
    if (
      !identity ||
      identity.identityId !== String(contact.id) ||
      identity.blocked === undefined ||
      identity.blocked !== contact.blocked
    ) {
      throw new SimpleLoginAliasError("SimpleLogin contact identity is stale", "conflict");
    }
    return identity;
  }

  private snapshot(alias: SimpleLoginAlias): AliasProviderSnapshot {
    return { alias: alias.identity, lifecycle: alias.enabled ? "enabled" : "disabled" };
  }

  private async loadJournal(): Promise<AliasSyncDocument | undefined> {
    return this.syncStore?.load();
  }

  private async record(
    document: AliasSyncDocument,
    input: AliasSyncEventInput,
  ): Promise<AliasSyncDocument> {
    return (await this.recordWithId(document, input)).document;
  }

  private async recordWithId(
    document: AliasSyncDocument,
    input: AliasSyncEventInput,
  ): Promise<{ document: AliasSyncDocument; eventId: string }> {
    if (!this.syncStore) {
      throw new SimpleLoginAliasError("Alias synchronization is not configured", "conflict");
    }
    const updated = appendAliasSyncEvent(document, input);
    const eventId = updated.events.at(-1)?.id;
    if (!eventId) {
      throw new SimpleLoginAliasError("The alias journal event was not created", "conflict");
    }
    await this.syncStore.save(updated);
    const persisted = await this.syncStore.load();
    if (!persisted.events.some((event) => event.id === eventId)) {
      throw new SimpleLoginAliasError("The alias journal event was not persisted", "conflict");
    }
    return { document: persisted, eventId };
  }

  private async remember(...aliases: SimpleLoginAlias[]): Promise<void> {
    let document = await this.loadJournal();
    if (!document || this.connectionWasRemoved(document)) {
      return;
    }
    for (const alias of aliases) {
      const known = projectAliasSync(document).aliases[emailAliasKey(alias.identity)];
      if (
        known?.identity.address === alias.identity.address &&
        known.status === (alias.enabled ? "enabled" : "disabled")
      ) {
        continue;
      }
      document = await this.record(document, {
        kind: "provider-observe",
        snapshot: this.snapshot(alias),
      });
    }
  }

  private async identityForId(id: number): Promise<EmailAliasIdentity> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new SimpleLoginAliasError("SimpleLogin alias id is invalid", "invalid-response");
    }
    const document = await this.loadJournal();
    if (document) {
      const known =
        projectAliasSync(document).aliases[
          `${this.adapter.connection.connectionId}\n${String(id)}`
        ];
      if (known && known.status !== "deleted") {
        return known.identity;
      }
    }
    const alias = this.detail(await this.getCanonical(String(id)));
    await this.remember(alias);
    return alias.identity;
  }

  private async assertMutationAllowed(): Promise<void> {
    const document = await this.loadJournal();
    if (!document) {
      return;
    }
    if (this.connectionWasRemoved(document)) {
      throw new SimpleLoginAliasError(
        "The alias connection was removed on another vault session",
        "conflict",
      );
    }
    if (
      projectAliasSync(document).conflicts.some(
        (conflict) => conflict.kind === "provider-state" || conflict.kind === "alias-identity",
      )
    ) {
      throw new SimpleLoginAliasError("An alias change requires conflict resolution", "conflict");
    }
  }

  private async journalMutation<Result>(
    operation: AliasProviderOperation,
    mutate: () => Promise<Result>,
  ): Promise<Result> {
    let document = await this.loadJournal();
    if (!document) {
      return mutate();
    }
    await this.assertMutationAllowed();
    const recorded = await this.recordWithId(document, {
      kind: "provider-operation",
      value: operation,
    });
    document = recorded.document;
    const operationId = recorded.eventId;
    document = await this.record(document, { kind: "provider-dispatched", operationId });
    try {
      const result = await mutate();
      await this.record(document, {
        kind: "provider-ack",
        operationId,
        snapshot: this.isAlias(result) ? this.snapshot(result) : undefined,
      });
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

  private isAlias(value: unknown): value is SimpleLoginAlias {
    return !!value && typeof value === "object" && "identity" in value && "enabled" in value;
  }

  private async recoverProviderOperations(): Promise<void> {
    if (!this.syncStore) {
      return;
    }
    if (this.recovering === undefined) {
      this.recovering = this.recoverProviderOperationsInternal().finally(() => {
        this.recovering = undefined;
      });
    }
    return this.recovering;
  }

  private async recoverProviderOperationsInternal(): Promise<void> {
    let document = await this.loadJournal();
    if (!document || this.connectionWasRemoved(document)) {
      return;
    }
    const unsettled = Object.values(projectAliasSync(document).operations).filter(
      ({ status }) => status === "prepared" || status === "dispatched" || status === "unknown",
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
      if (pending.status !== "unknown") {
        document = await this.record(document, { kind: "provider-unknown", operationId });
      }
      throw new SimpleLoginAliasError(
        "An alias creation outcome requires reconciliation",
        "conflict",
      );
    }
    const identity = operation.alias;
    if (operation.operation === "delete") {
      try {
        await this.withClient((client) => client.get(identity));
      } catch (error) {
        if (normalizeSimpleLoginAliasError(error).code === "not-found") {
          return this.record(document, { kind: "provider-ack", operationId });
        }
        throw error;
      }
      await this.withClient((client) => client.delete(identity));
      return this.record(document, { kind: "provider-ack", operationId });
    }
    const enabled = operation.operation === "enable";
    let observed = await this.withClient((client) => client.get(identity));
    if ((observed.lifecycle === "enabled") !== enabled) {
      observed = await this.withClient((client) => client.set_enabled(identity, enabled));
    }
    return this.record(document, {
      kind: "provider-ack",
      operationId,
      snapshot: { alias: observed.identity, lifecycle: observed.lifecycle },
    });
  }

  private connectionWasRemoved(document: AliasSyncDocument): boolean {
    const key = aliasConnectionKey({
      version: 1,
      connectionId: this.adapter.connection.connectionId,
    });
    return projectAliasSync(document).connections[key]?.status === "removed";
  }

  private withClientSync<Result>(operation: (client: AliasClient) => Result): Result {
    let client: AliasClient;
    try {
      client = new AliasClient(this.adapter.connection, this.adapter);
    } catch (error) {
      throw normalizeSimpleLoginAliasError(error);
    }
    try {
      return operation(client);
    } finally {
      client.free();
    }
  }

  private async withClient<Result>(
    operation: (client: AliasClient) => Promise<Result>,
  ): Promise<Result> {
    const previous = this.operationTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.operationTail = tail;
    await previous;
    let client: AliasClient;
    try {
      client = new AliasClient(this.adapter.connection, this.adapter);
    } catch (error) {
      release();
      if (this.operationTail === tail) {
        this.operationTail = Promise.resolve();
      }
      throw normalizeSimpleLoginAliasError(error);
    }
    try {
      return await operation(client);
    } catch (error) {
      const normalized = normalizeSimpleLoginAliasError(error);
      const details = this.adapter.takeFailureDetails();
      throw details
        ? new SimpleLoginAliasError(
            normalized.message,
            normalized.code,
            details.status,
            details.retryAfterSeconds,
          )
        : normalized;
    } finally {
      client.free();
      release();
      if (this.operationTail === tail) {
        this.operationTail = Promise.resolve();
      }
    }
  }

  private async safe<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      throw normalizeSimpleLoginAliasError(error);
    }
  }
}

export function createSimpleLoginAliasService(
  settings: SimpleLoginAliasSettings,
): SimpleLoginAliasService {
  try {
    const runtime = validateSimpleLoginRuntimeSettings(
      settings.token,
      settings.baseUrl,
      settings.connectionId,
    );
    const adapter = new SimpleLoginAliasAdapter(
      runtime.token,
      runtime.baseUrl,
      runtime.connectionId,
    );
    const client = new AliasClient(adapter.connection, adapter);
    client.free();
    return new SimpleLoginAliasService(adapter, settings.syncStore);
  } catch (error) {
    throw normalizeSimpleLoginAliasError(error);
  }
}
