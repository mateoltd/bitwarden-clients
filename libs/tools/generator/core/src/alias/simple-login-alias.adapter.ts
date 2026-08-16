import {
  Alias,
  AliasAdapterFailure,
  AliasAdapterResult,
  AliasConnection,
  AliasErrorCode,
  AliasIdentity,
  AliasPage,
  AliasProviderAdapter,
  AliasProviderCapabilities,
  CreateAliasRequest,
  CreateSendReplyIdentityRequest,
  DeleteAliasResult,
  ListAliasesRequest,
  SendReplyIdentity,
  SendReplyIdentityPage,
  SensitiveString,
} from "@bitwarden/alias-sdk-internal";
import { parseEmailAliasIdentity } from "@bitwarden/common/tools/alias";

import { SimpleLoginAliasError } from "./simple-login-alias.error";
import {
  CreateSimpleLoginAliasRequest,
  SimpleLoginAlias,
  SimpleLoginAliasDomain,
  SimpleLoginAliasFilter,
  SimpleLoginAliasRecommendation,
  SimpleLoginContact,
  UpdateSimpleLoginAliasRequest,
} from "./simple-login-alias.types";

const MAX_SUCCESS_RESPONSE_BYTES = 512 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;
const MAX_CONTACT_LOOKUP_PAGES = 32;
const MAX_TOGGLE_ATTEMPTS = 3;
const PAGE_SIZE = 20;

const capabilities: AliasProviderCapabilities = Object.freeze({
  create: true,
  list: true,
  get: true,
  enableDisable: true,
  delete: true,
  createSendReplyIdentity: true,
  listSendReplyIdentities: true,
  removeSendReplyIdentity: true,
  extensions: ["send-reply.block"],
});

type JsonRecord = Record<string, unknown>;

function record(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(field);
  }
  return value as JsonRecord;
}

function stringValue(value: unknown, field: string, max = 16 * 1024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    [...value].some((character) => character < " ")
  ) {
    throw invalidResponse(field);
  }
  return value;
}

function optionalString(value: unknown, field: string, max = 16 * 1024): string | null {
  return value === null || value === undefined ? null : stringValue(value, field, max);
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw invalidResponse(field);
  }
  return value as number;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidResponse(field);
  }
  return value;
}

function safeEmail(value: unknown, field: string): string {
  const address = stringValue(value, field, 320).trim().toLowerCase();
  const [local, domain, extra] = address.split("@");
  if (!local || !domain || extra || /[\s<>]/.test(address)) {
    throw invalidResponse(field);
  }
  return address;
}

function invalidResponse(field: string): SimpleLoginAliasError {
  return new SimpleLoginAliasError(`SimpleLogin returned an invalid ${field}`, "invalid-response");
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") {
    return true;
  }
  const octets = normalized.split(".").map(Number);
  return octets.length === 4 && octets.every(Number.isInteger) && octets[0] === 127;
}

export function canonicalSimpleLoginBaseUrl(value?: string): string {
  let url: URL;
  try {
    url = new URL(value?.trim() || "https://app.simplelogin.io");
  } catch {
    throw new SimpleLoginAliasError("SimpleLogin endpoint is invalid", "invalid-response");
  }
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
  ) {
    throw new SimpleLoginAliasError("SimpleLogin endpoint is invalid", "invalid-response");
  }
  url.pathname = `${url.pathname.replace(/\/*$/, "")}/`;
  return url.toString();
}

export function validateSimpleLoginRuntimeSettings(
  token: string,
  baseUrl: string | undefined,
  connectionId: string,
): { token: string; baseUrl: string; connectionId: string } {
  const normalizedToken = token.trim();
  if (!normalizedToken || /[\r\n\0]/.test(token)) {
    throw new SimpleLoginAliasError("SimpleLogin credentials are invalid", "invalid-response");
  }
  const identity = parseEmailAliasIdentity({
    version: 1,
    connectionId,
    aliasId: "validation",
    address: "validation@example.invalid",
  });
  if (!identity) {
    throw new SimpleLoginAliasError(
      "SimpleLogin connection identity is invalid",
      "invalid-response",
    );
  }
  return { token: normalizedToken, baseUrl: canonicalSimpleLoginBaseUrl(baseUrl), connectionId };
}

function adapterFailure(error: unknown, mutation: boolean): AliasAdapterFailure {
  const normalized =
    error instanceof SimpleLoginAliasError
      ? error
      : new SimpleLoginAliasError("SimpleLogin could not be reached", "remote-error");
  let code: AliasErrorCode;
  switch (normalized.code) {
    case "invalid-credentials":
      code = "authentication-rejected";
      break;
    case "forbidden":
      code = "permission-denied";
      break;
    case "not-found":
      code = "not-found";
      break;
    case "rate-limited":
      code = "rate-limited";
      break;
    case "conflict":
      code = "sync-conflict";
      break;
    case "invalid-response":
      code = "invalid-response";
      break;
    default:
      code = mutation ? "outcome-unknown" : "offline";
      break;
  }
  return { code, retryAfterSeconds: normalized.retryAfterSeconds };
}

function pageToken(page: number): string | undefined {
  return page > 0 ? `simplelogin-page:${page}` : undefined;
}

function parsePageToken(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }
  const match = /^simplelogin-page:(\d{1,8})$/.exec(value);
  if (!match) {
    throw new SimpleLoginAliasError("SimpleLogin page is invalid", "invalid-response");
  }
  return integer(Number(match[1]), "page");
}

function filterQuery(filter: SimpleLoginAliasFilter): string | undefined {
  return filter === "all" ? undefined : filter;
}

type NativeSimpleLoginContact = Omit<SimpleLoginContact, "identity">;

/** Runtime-only concrete adapter. It is deliberately absent from public barrels and common types. */
export class SimpleLoginAliasAdapter implements AliasProviderAdapter {
  readonly connection: AliasConnection;
  private readonly aliases = new Map<string, SimpleLoginAlias>();
  private readonly contacts = new Map<
    string,
    { alias: AliasIdentity; contact: NativeSimpleLoginContact }
  >();
  private readonly locks = new Map<string, Promise<void>>();
  private createIntent: CreateSimpleLoginAliasRequest | undefined;
  private listIntent: { query?: string; filter: SimpleLoginAliasFilter } | undefined;
  private failureDetails: { status?: number; retryAfterSeconds?: number } | undefined;

  constructor(
    private readonly token: string,
    private readonly baseUrl: string,
    connectionId: string,
  ) {
    this.connection = {
      version: 1,
      connectionId,
      adapter: { adapterId: "simplelogin", capabilities },
    };
  }

  async withCreateIntent<Result>(
    intent: CreateSimpleLoginAliasRequest,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return this.exclusive("create", async () => {
      this.createIntent = intent;
      try {
        return await operation();
      } finally {
        this.createIntent = undefined;
      }
    });
  }

  async withListIntent<Result>(
    query: string | undefined,
    filter: SimpleLoginAliasFilter,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return this.exclusive("list", async () => {
      this.listIntent = { query, filter };
      try {
        return await operation();
      } finally {
        this.listIntent = undefined;
      }
    });
  }

  detail(identity: AliasIdentity): SimpleLoginAlias | undefined {
    return this.aliases.get(this.identityKey(identity));
  }

  contactDetail(identityId: string): NativeSimpleLoginContact | undefined {
    return this.contacts.get(identityId)?.contact;
  }

  takeFailureDetails(): { status?: number; retryAfterSeconds?: number } | undefined {
    const details = this.failureDetails;
    this.failureDetails = undefined;
    return details;
  }

  async options(hostname: string): Promise<SimpleLoginAliasRecommendation> {
    const params = new URLSearchParams();
    if (hostname) {
      params.set("hostname", hostname);
    }
    const value = record(
      await this.request("GET", `api/v5/alias/options${params.size ? `?${params}` : ""}`),
      "alias options",
    );
    const suffixes = Array.isArray(value.suffixes)
      ? value.suffixes.map((candidate) => {
          const suffix = record(candidate, "alias suffix");
          return {
            suffix: stringValue(suffix.suffix, "alias suffix", 4 * 1024),
            signedSuffix: stringValue(suffix.signed_suffix, "signed suffix", 4 * 1024),
            isCustom: booleanValue(suffix.is_custom, "custom suffix flag"),
            isPremium: booleanValue(suffix.is_premium, "premium suffix flag"),
          };
        })
      : (() => {
          throw invalidResponse("alias suffixes");
        })();
    const recommendation = value.recommendation;
    let alias: SimpleLoginAlias | undefined;
    if (recommendation !== null && recommendation !== undefined) {
      const recommended = record(recommendation, "alias recommendation");
      const address = safeEmail(recommended.alias, "recommended alias address");
      alias = (await this.listNative(0, address, "all")).find(
        (candidate) => candidate.address === address,
      );
    }
    return {
      hostname,
      canCreate: booleanValue(value.can_create, "alias creation flag"),
      prefixSuggestion: typeof value.prefix_suggestion === "string" ? value.prefix_suggestion : "",
      suffixes,
      alias,
    };
  }

  async listNative(
    page: number,
    query?: string,
    filter: SimpleLoginAliasFilter = "all",
  ): Promise<SimpleLoginAlias[]> {
    const params = new URLSearchParams({ page_id: String(page) });
    const filterValue = filterQuery(filter);
    if (filterValue) {
      params.set(filterValue, "true");
    }
    const value = record(
      await this.request(
        query ? "POST" : "GET",
        `api/v2/aliases?${params}`,
        query ? { query } : undefined,
      ),
      "alias page",
    );
    if (!Array.isArray(value.aliases)) {
      throw invalidResponse("alias page");
    }
    const aliases = value.aliases.map((candidate) => this.parseAlias(candidate));
    if (new Set(aliases.map((alias) => alias.id)).size !== aliases.length) {
      throw invalidResponse("alias page identifiers");
    }
    return aliases;
  }

  async getNative(aliasId: string): Promise<SimpleLoginAlias> {
    const id = this.numericId(aliasId, "alias id");
    const alias = this.parseAlias(await this.request("GET", `api/aliases/${id}`));
    if (alias.id !== id) {
      throw invalidResponse("alias id");
    }
    return alias;
  }

  async updateNative(
    identity: AliasIdentity,
    update: UpdateSimpleLoginAliasRequest,
  ): Promise<SimpleLoginAlias> {
    const id = this.numericIdentity(identity);
    const body: JsonRecord = {};
    if (update.note !== undefined) {
      body.note = update.note;
    }
    if (update.name !== undefined) {
      body.name = update.name;
    }
    if (update.mailboxIds !== undefined) {
      body.mailbox_ids = update.mailboxIds;
    }
    if (update.pgpDisabled !== undefined) {
      body.disable_pgp = update.pgpDisabled;
    }
    if (update.pinned !== undefined) {
      body.pinned = update.pinned;
    }
    if (Object.keys(body).length === 0) {
      throw new SimpleLoginAliasError("SimpleLogin update is empty", "invalid-response");
    }
    const response = record(await this.request("PATCH", `api/aliases/${id}`, body, true), "update");
    if (response.ok !== true) {
      throw invalidResponse("alias update response");
    }
    return this.getNative(String(id));
  }

  async domains(): Promise<SimpleLoginAliasDomain[]> {
    const value = await this.request("GET", "api/v2/setting/domains");
    if (!Array.isArray(value)) {
      throw invalidResponse("alias domains");
    }
    return value.map((candidate) => {
      const domain = record(candidate, "alias domain");
      return {
        domain: stringValue(domain.domain, "alias domain", 253),
        isCustom: booleanValue(domain.is_custom, "custom domain flag"),
      };
    });
  }

  async contactsNative(identity: AliasIdentity, page: number): Promise<NativeSimpleLoginContact[]> {
    const aliasId = this.numericIdentity(identity);
    const value = record(
      await this.request("GET", `api/aliases/${aliasId}/contacts?page_id=${page}`),
      "contact page",
    );
    if (!Array.isArray(value.contacts)) {
      throw invalidResponse("contact page");
    }
    const contacts = value.contacts.map((candidate) => this.parseContact(identity, candidate));
    if (new Set(contacts.map((contact) => contact.id)).size !== contacts.length) {
      throw invalidResponse("contact identifiers");
    }
    return contacts;
  }

  async createContact(
    identity: AliasIdentity,
    recipient: string,
  ): Promise<NativeSimpleLoginContact> {
    const aliasId = this.numericIdentity(identity);
    return this.parseContact(
      identity,
      await this.request("POST", `api/aliases/${aliasId}/contacts`, { contact: recipient }, true),
    );
  }

  async deleteContact(contactId: string): Promise<void> {
    const id = this.numericId(contactId, "contact id");
    const response = record(
      await this.request("DELETE", `api/contacts/${id}`, undefined, true),
      "delete",
    );
    if (response.deleted !== true) {
      throw invalidResponse("contact deletion response");
    }
    this.contacts.delete(String(id));
  }

  async toggleCachedContact(contactId: string): Promise<boolean> {
    const cached = this.contacts.get(contactId);
    if (!cached) {
      throw new SimpleLoginAliasError("SimpleLogin contact is not loaded", "conflict");
    }
    const updated = await this.setContactBlocked(cached.alias, contactId, !cached.contact.blocked);
    return updated.blocked;
  }

  async create(request: CreateAliasRequest): Promise<AliasAdapterResult<Alias>> {
    return this.result(true, async () => this.toSdkAlias(await this.createNative(request)));
  }

  async list(request: ListAliasesRequest): Promise<AliasAdapterResult<AliasPage>> {
    return this.result(false, async () => {
      const page = parsePageToken(request.pageToken);
      const aliases = await this.listNative(
        page,
        this.listIntent?.query,
        this.listIntent?.filter ?? "all",
      );
      return {
        aliases: aliases.map((alias) => this.toSdkAlias(alias)),
        nextPageToken: aliases.length === PAGE_SIZE ? pageToken(page + 1) : undefined,
      };
    });
  }

  async get(identity: AliasIdentity): Promise<AliasAdapterResult<Alias>> {
    return this.result(false, async () => this.toSdkAlias(await this.getNative(identity.aliasId)));
  }

  async setEnabled(identity: AliasIdentity, enabled: boolean): Promise<AliasAdapterResult<Alias>> {
    return this.result(true, async () =>
      this.exclusive(`alias:${identity.aliasId}`, async () => {
        let current = await this.getNative(identity.aliasId);
        for (
          let attempt = 0;
          attempt < MAX_TOGGLE_ATTEMPTS && current.enabled !== enabled;
          attempt++
        ) {
          await this.request(
            "POST",
            `api/aliases/${this.numericIdentity(identity)}/toggle`,
            undefined,
            true,
          );
          current = await this.getNative(identity.aliasId);
        }
        if (current.enabled !== enabled) {
          throw new SimpleLoginAliasError("SimpleLogin state did not converge", "conflict");
        }
        return this.toSdkAlias(current);
      }),
    );
  }

  async delete(identity: AliasIdentity): Promise<AliasAdapterResult<DeleteAliasResult>> {
    return this.result(true, async (): Promise<DeleteAliasResult> => {
      const id = this.numericIdentity(identity);
      try {
        const response = record(
          await this.request("DELETE", `api/aliases/${id}`, undefined, true),
          "alias deletion",
        );
        if (response.deleted !== true) {
          throw invalidResponse("alias deletion response");
        }
      } catch (error) {
        if (!(error instanceof SimpleLoginAliasError) || error.code !== "not-found") {
          throw error;
        }
      }
      this.aliases.delete(this.identityKey(identity));
      return { identity, deleted: true };
    });
  }

  async createSendReplyIdentity(
    request: CreateSendReplyIdentityRequest,
  ): Promise<AliasAdapterResult<SendReplyIdentity>> {
    return this.result(true, async () =>
      this.toSendReplyIdentity(
        request.alias,
        await this.createContact(request.alias, request.recipient as string),
      ),
    );
  }

  async listSendReplyIdentities(
    identity: AliasIdentity,
    nextPageToken?: string,
  ): Promise<AliasAdapterResult<SendReplyIdentityPage>> {
    return this.result(false, async () => {
      const page = parsePageToken(nextPageToken);
      const contacts = await this.contactsNative(identity, page);
      return {
        identities: contacts.map((contact) => this.toSendReplyIdentity(identity, contact)),
        nextPageToken: contacts.length === PAGE_SIZE ? pageToken(page + 1) : undefined,
      };
    });
  }

  async removeSendReplyIdentity(identity: SendReplyIdentity): Promise<AliasAdapterResult<null>> {
    return this.result(true, async (): Promise<null> => {
      await this.deleteContact(identity.identityId);
      return null;
    });
  }

  async setSendReplyBlocked(
    identity: SendReplyIdentity,
    blocked: boolean,
  ): Promise<AliasAdapterResult<SendReplyIdentity>> {
    return this.result(true, async () => {
      const contact = await this.setContactBlocked(identity.alias, identity.identityId, blocked);
      return this.toSendReplyIdentity(identity.alias, contact);
    });
  }

  private async createNative(request: CreateAliasRequest): Promise<SimpleLoginAlias> {
    const intent = this.createIntent ?? {
      kind: "random",
      hostname: request.hostname as string | undefined,
    };
    const params = new URLSearchParams();
    if (request.hostname) {
      params.set("hostname", request.hostname as string);
    }
    if (intent.kind === "random" && intent.mode) {
      params.set("mode", intent.mode);
    }
    const path = intent.kind === "custom" ? "api/v3/alias/custom/new" : "api/alias/random/new";
    const body =
      intent.kind === "custom"
        ? {
            alias_prefix: intent.aliasPrefix,
            signed_suffix: intent.signedSuffix,
            mailbox_ids: intent.mailboxIds,
            note: intent.note,
            name: intent.name,
          }
        : { note: intent.note };
    return this.parseAlias(
      await this.request("POST", `${path}${params.size ? `?${params}` : ""}`, body, true),
    );
  }

  private parseAlias(value: unknown): SimpleLoginAlias {
    const candidate = record(value, "alias");
    const id = integer(candidate.id, "alias id", 1);
    const address = safeEmail(candidate.email, "alias address");
    const mailboxes = Array.isArray(candidate.mailboxes)
      ? candidate.mailboxes.map((value) => {
          const mailbox = record(value, "mailbox");
          return {
            id: integer(mailbox.id, "mailbox id", 1),
            email: safeEmail(mailbox.email, "mailbox address"),
          };
        })
      : (() => {
          throw invalidResponse("mailboxes");
        })();
    const latest = candidate.latest_activity;
    const identity = parseEmailAliasIdentity({
      version: 1,
      connectionId: this.connection.connectionId,
      aliasId: String(id),
      address,
    });
    if (
      !identity ||
      mailboxes.length === 0 ||
      new Set(mailboxes.map(({ id }) => id)).size !== mailboxes.length
    ) {
      throw invalidResponse("alias identity");
    }
    const alias: SimpleLoginAlias = {
      id,
      address,
      name: optionalString(candidate.name, "alias name", 128),
      note: optionalString(candidate.note, "alias note"),
      enabled: booleanValue(candidate.enabled, "alias state"),
      pinned:
        candidate.pinned === undefined ? false : booleanValue(candidate.pinned, "pinned state"),
      createdAt: integer(candidate.creation_timestamp, "creation timestamp"),
      blockedCount: integer(candidate.nb_block, "blocked count"),
      forwardedCount: integer(candidate.nb_forward, "forwarded count"),
      repliedCount: integer(candidate.nb_reply, "reply count"),
      supportsPgp: booleanValue(candidate.support_pgp, "PGP support"),
      pgpDisabled: booleanValue(candidate.disable_pgp, "PGP state"),
      mailboxes,
      latestActivity:
        latest === null || latest === undefined
          ? null
          : (() => {
              const activity = record(latest, "alias activity");
              const contact = record(activity.contact, "activity contact");
              const action = stringValue(activity.action, "activity action", 32);
              if (!(["forward", "reply", "block", "bounced"] as string[]).includes(action)) {
                throw invalidResponse("activity action");
              }
              return {
                action: action as "forward" | "reply" | "block" | "bounced",
                timestamp: integer(activity.timestamp, "activity timestamp"),
                contact: {
                  email: safeEmail(contact.email, "activity contact"),
                  name: optionalString(contact.name, "activity contact name", 128),
                  reverseAlias: stringValue(contact.reverse_alias, "reverse alias", 1024),
                },
              };
            })(),
      identity,
    };
    this.aliases.set(this.identityKey(identity), alias);
    return alias;
  }

  private parseContact(alias: AliasIdentity, value: unknown): NativeSimpleLoginContact {
    const candidate = record(value, "contact");
    const contact: NativeSimpleLoginContact = {
      id: integer(candidate.id, "contact id", 1),
      address: safeEmail(candidate.contact, "contact address"),
      reverseAlias: stringValue(candidate.reverse_alias, "reverse alias", 1024),
      reverseAliasAddress: safeEmail(candidate.reverse_alias_address, "reverse alias address"),
      createdAt: integer(candidate.creation_timestamp, "contact creation timestamp"),
      lastEmailSentAt:
        candidate.last_email_sent_timestamp === null ||
        candidate.last_email_sent_timestamp === undefined
          ? null
          : integer(candidate.last_email_sent_timestamp, "last email timestamp"),
      blocked: booleanValue(candidate.block_forward, "contact blocked state"),
      existed:
        candidate.existed === undefined
          ? false
          : booleanValue(candidate.existed, "contact existed state"),
    };
    this.contacts.set(String(contact.id), { alias, contact });
    return contact;
  }

  private toSdkAlias(alias: SimpleLoginAlias): Alias {
    return {
      identity: alias.identity,
      lifecycle: alias.enabled ? "enabled" : "disabled",
      freshness: "current",
      consistency: "clean",
      label: undefined,
      capabilities,
    };
  }

  private toSendReplyIdentity(
    alias: AliasIdentity,
    contact: NativeSimpleLoginContact,
  ): SendReplyIdentity {
    return {
      alias,
      identityId: String(contact.id),
      recipient: contact.address as SensitiveString,
      address: contact.reverseAliasAddress as SensitiveString,
      valid: true,
      blocked: contact.blocked,
    };
  }

  private numericIdentity(identity: AliasIdentity): number {
    if (identity.connectionId !== this.connection.connectionId) {
      throw new SimpleLoginAliasError(
        "SimpleLogin identity belongs to another connection",
        "forbidden",
      );
    }
    return this.numericId(identity.aliasId, "alias id");
  }

  private numericId(value: string, field: string): number {
    if (!/^[1-9]\d*$/.test(value)) {
      throw new SimpleLoginAliasError(`SimpleLogin ${field} is invalid`, "invalid-response");
    }
    const id = Number(value);
    if (!Number.isSafeInteger(id)) {
      throw new SimpleLoginAliasError(`SimpleLogin ${field} is invalid`, "invalid-response");
    }
    return id;
  }

  private identityKey(identity: AliasIdentity): string {
    return `${identity.connectionId}\n${identity.aliasId}`;
  }

  private async setContactBlocked(
    alias: AliasIdentity,
    contactId: string,
    blocked: boolean,
  ): Promise<NativeSimpleLoginContact> {
    return this.exclusive(`contact:${contactId}`, async () => {
      let current = await this.findContact(alias, contactId);
      for (
        let attempt = 0;
        attempt < MAX_TOGGLE_ATTEMPTS && current.blocked !== blocked;
        attempt++
      ) {
        await this.request(
          "POST",
          `api/contacts/${this.numericId(contactId, "contact id")}/toggle`,
          undefined,
          true,
        );
        current = await this.findContact(alias, contactId);
      }
      if (current.blocked !== blocked) {
        throw new SimpleLoginAliasError("SimpleLogin contact state did not converge", "conflict");
      }
      return current;
    });
  }

  private async findContact(
    alias: AliasIdentity,
    contactId: string,
  ): Promise<NativeSimpleLoginContact> {
    const expected = this.numericId(contactId, "contact id");
    for (let page = 0; page < MAX_CONTACT_LOOKUP_PAGES; page++) {
      const contacts = await this.contactsNative(alias, page);
      const match = contacts.find(({ id }) => id === expected);
      if (match) {
        return match;
      }
      if (contacts.length < PAGE_SIZE) {
        break;
      }
    }
    throw new SimpleLoginAliasError("SimpleLogin contact was not found", "not-found", 404);
  }

  private async result<Value>(
    mutation: boolean,
    operation: () => Promise<Value>,
  ): Promise<AliasAdapterResult<Value>> {
    try {
      const value = await operation();
      this.failureDetails = undefined;
      return { status: "success", value };
    } catch (error) {
      this.failureDetails =
        error instanceof SimpleLoginAliasError
          ? { status: error.status, retryAfterSeconds: error.retryAfterSeconds }
          : undefined;
      return { status: "failure", failure: adapterFailure(error, mutation) };
    }
  }

  private async exclusive<Value>(key: string, operation: () => Promise<Value>): Promise<Value> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    this.locks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === current) {
        this.locks.delete(key);
      }
    }
  }

  private async request(
    method: string,
    relative: string,
    body?: unknown,
    mutation = false,
  ): Promise<unknown> {
    const url = new URL(relative, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new SimpleLoginAliasError("SimpleLogin request path is invalid", "invalid-response");
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        redirect: "manual",
        credentials: "omit",
        headers: {
          Accept: "application/json",
          Authentication: this.token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new SimpleLoginAliasError(
        mutation ? "SimpleLogin mutation outcome is unknown" : "SimpleLogin could not be reached",
        "remote-error",
      );
    }
    if (
      !response ||
      typeof response.status !== "number" ||
      !response.headers ||
      typeof response.headers.get !== "function" ||
      response.status === 0 ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw new SimpleLoginAliasError(
        "SimpleLogin redirect rejected",
        "invalid-response",
        response?.status,
      );
    }
    const limit = response.ok ? MAX_SUCCESS_RESPONSE_BYTES : MAX_ERROR_RESPONSE_BYTES;
    const bytes = await this.readBounded(response, limit, mutation);
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterSeconds =
        retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
      if (response.status === 401) {
        throw new SimpleLoginAliasError(
          "SimpleLogin authentication failed",
          "invalid-credentials",
          401,
        );
      }
      if (response.status === 403) {
        throw new SimpleLoginAliasError("SimpleLogin permission denied", "forbidden", 403);
      }
      if (response.status === 404) {
        throw new SimpleLoginAliasError("SimpleLogin resource not found", "not-found", 404);
      }
      if (response.status === 429) {
        throw new SimpleLoginAliasError(
          "SimpleLogin rate limit reached",
          "rate-limited",
          429,
          retryAfterSeconds,
        );
      }
      throw new SimpleLoginAliasError(
        "SimpleLogin request failed",
        "remote-error",
        response.status,
      );
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
      throw invalidResponse("content type");
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw invalidResponse("JSON response");
    }
  }

  private async readBounded(
    response: Response,
    limit: number,
    mutation: boolean,
  ): Promise<Uint8Array> {
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
      throw new SimpleLoginAliasError(
        "SimpleLogin response exceeded the size limit",
        "invalid-response",
      );
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      throw invalidResponse("response body");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        if (!ArrayBuffer.isView(result.value)) {
          throw invalidResponse("response stream");
        }
        const chunk = new Uint8Array(
          result.value.buffer,
          result.value.byteOffset,
          result.value.byteLength,
        );
        total += chunk.byteLength;
        if (total > limit) {
          await reader.cancel().catch((): undefined => undefined);
          throw new SimpleLoginAliasError(
            "SimpleLogin response exceeded the size limit",
            "invalid-response",
          );
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof SimpleLoginAliasError) {
        throw error;
      }
      throw new SimpleLoginAliasError(
        mutation ? "SimpleLogin mutation outcome is unknown" : "SimpleLogin response stream failed",
        "remote-error",
      );
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}
