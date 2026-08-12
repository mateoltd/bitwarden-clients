import { normalizeEmailAliasAddress } from "@bitwarden/common/tools/alias";
import {
  Alias,
  AliasClient,
  AliasClientSettings,
  AliasFilter,
  AliasPage,
  AliasProviderIdentity,
  AliasUpdateRequest,
  OptionalSensitiveStringUpdate,
  ReverseAlias,
  SensitiveString,
  parse_alias_reference,
} from "@bitwarden/sdk-internal";

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
    identity: {
      version: 2,
      provider: reference.provider,
      providerInstance: reference.providerInstance,
      connectionId: reference.connectionId,
      aliasId: reference.aliasId.toString(),
      address: reference.address as string,
    },
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
  constructor(private readonly settings: AliasClientSettings) {}

  providerIdentity(): AliasProviderIdentity {
    const client = new AliasClient(this.settings);
    try {
      return client.provider_identity();
    } finally {
      client.free();
    }
  }

  async recommend(website: string): Promise<SimpleLoginAliasRecommendation> {
    return this.safe(async (client) => {
      const hostname = normalizedHostname(website) ?? "";
      const options = await client.get_alias_options(hostname || undefined);
      let alias: SimpleLoginAlias | undefined;
      if (options.recommendation) {
        alias = await this.findByAddress(options.recommendation.alias as string);
      }
      return {
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
    });
  }

  async create(request: CreateSimpleLoginAliasRequest = {}): Promise<SimpleLoginAlias> {
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
    const result = await this.listCanonical(page, query, filter);
    const items = await this.safe(async (client) =>
      result.aliases.map((alias) => simpleLoginAliasFromSdk(client, alias)),
    );
    return { items, page, nextPage: items.length === SIMPLELOGIN_PAGE_SIZE ? page + 1 : undefined };
  }

  async get(id: number): Promise<SimpleLoginAlias> {
    return this.safe(async (client) =>
      simpleLoginAliasFromSdk(client, await client.get_alias(positiveId(id, "alias id"))),
    );
  }

  async update(id: number, update: UpdateSimpleLoginAliasRequest): Promise<SimpleLoginAlias> {
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
    return this.safe(async (client) => {
      const aliasId = positiveId(id, "alias id");
      await client.set_alias_enabled(aliasId, enabled);
      return simpleLoginAliasFromSdk(client, await client.get_alias(aliasId));
    });
  }

  async delete(id: number): Promise<void> {
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

  private async findByAddress(address: string): Promise<SimpleLoginAlias | undefined> {
    const result = await this.list(0, address);
    const normalized = normalizeEmailAliasAddress(address);
    return result.items.find((alias) => normalizeEmailAliasAddress(alias.address) === normalized);
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
    return new SimpleLoginAliasService(sdkSettings);
  } catch (error) {
    throw normalizeSimpleLoginAliasError(error);
  }
}
