import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { normalizeEmailAliasAddress } from "@bitwarden/common/tools/alias";

import { SimpleLoginAliasTransport } from "./simple-login-alias.transport";
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

const SIMPLELOGIN_PAGE_SIZE = 20;

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`SimpleLogin response is missing ${field}`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`SimpleLogin response is missing ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function simpleLoginAliasFromJson(json: any): SimpleLoginAlias {
  const mailboxes = Array.isArray(json?.mailboxes)
    ? json.mailboxes.map((mailbox: any) => ({
        id: requiredNumber(mailbox?.id, "mailbox id"),
        email: requiredString(mailbox?.email, "mailbox email"),
      }))
    : [];

  const latest = json?.latest_activity;
  return {
    id: requiredNumber(json?.id, "alias id"),
    address: requiredString(json?.email ?? json?.alias, "alias address"),
    name: optionalString(json?.name),
    note: optionalString(json?.note),
    enabled: json?.enabled === true,
    pinned: json?.pinned === true,
    createdAt: requiredNumber(json?.creation_timestamp, "creation timestamp"),
    blockedCount: Number(json?.nb_block ?? 0),
    forwardedCount: Number(json?.nb_forward ?? 0),
    repliedCount: Number(json?.nb_reply ?? 0),
    supportsPgp: json?.support_pgp === true,
    pgpDisabled: json?.disable_pgp === true,
    mailboxes,
    latestActivity:
      latest && latest.contact
        ? {
            action: latest.action,
            timestamp: requiredNumber(latest.timestamp, "activity timestamp"),
            contact: {
              email: requiredString(latest.contact.email, "activity contact"),
              name: optionalString(latest.contact.name),
              reverseAlias: requiredString(latest.contact.reverse_alias, "activity reverse alias"),
            },
          }
        : null,
  };
}

function simpleLoginContactFromJson(json: any): SimpleLoginContact {
  return {
    id: requiredNumber(json?.id, "contact id"),
    address: requiredString(json?.contact, "contact address"),
    reverseAlias: requiredString(json?.reverse_alias, "reverse alias"),
    reverseAliasAddress: requiredString(json?.reverse_alias_address, "reverse alias address"),
    createdAt: requiredNumber(json?.creation_timestamp, "contact creation timestamp"),
    lastEmailSentAt:
      typeof json?.last_email_sent_timestamp === "number" ? json.last_email_sent_timestamp : null,
    blocked: json?.block_forward === true,
    existed: json?.existed === true,
  };
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

/** Stable Angular-independent lifecycle service backed by the real SimpleLogin API. */
export class SimpleLoginAliasService {
  private readonly settings: SimpleLoginAliasSettings;

  constructor(
    private readonly transport: SimpleLoginAliasTransport,
    settings: SimpleLoginAliasSettings,
  ) {
    this.settings = { token: settings.token, baseUrl: settings.baseUrl };
  }

  async recommend(website: string): Promise<SimpleLoginAliasRecommendation> {
    const hostname = normalizedHostname(website) ?? "";
    const json = await this.transport.request<any>(this.settings, "api/v5/alias/options", {
      query: { hostname: hostname || undefined },
    });

    let alias: SimpleLoginAlias | undefined;
    const recommendedAddress = json?.recommendation?.alias;
    if (typeof recommendedAddress === "string") {
      alias = await this.findByAddress(recommendedAddress);
    }

    return {
      hostname,
      canCreate: json?.can_create === true,
      prefixSuggestion: typeof json?.prefix_suggestion === "string" ? json.prefix_suggestion : "",
      suffixes: Array.isArray(json?.suffixes)
        ? json.suffixes.map((suffix: any) => ({
            suffix: requiredString(suffix?.suffix, "alias suffix"),
            signedSuffix: requiredString(suffix?.signed_suffix, "signed alias suffix"),
            isCustom: suffix?.is_custom === true,
            isPremium: suffix?.is_premium === true,
          }))
        : [],
      alias,
    };
  }

  async create(request: CreateSimpleLoginAliasRequest = {}): Promise<SimpleLoginAlias> {
    const hostname = normalizedHostname(request.hostname);
    if (request.kind === "custom") {
      const json = await this.transport.request<any>(this.settings, "api/v3/alias/custom/new", {
        method: "POST",
        query: { hostname },
        body: {
          alias_prefix: request.aliasPrefix,
          signed_suffix: request.signedSuffix,
          mailbox_ids: request.mailboxIds,
          note: request.note,
          name: request.name,
        },
      });
      return simpleLoginAliasFromJson(json);
    }

    const json = await this.transport.request<any>(this.settings, "api/alias/random/new", {
      method: "POST",
      query: { hostname, mode: request.mode },
      body: request.note === undefined ? {} : { note: request.note },
    });
    return simpleLoginAliasFromJson(json);
  }

  async list(
    page = 0,
    query?: string,
    filter: SimpleLoginAliasFilter = "all",
  ): Promise<SimpleLoginAliasPage> {
    const json = await this.transport.request<any>(this.settings, "api/v2/aliases", {
      method: query ? "POST" : "GET",
      query: {
        page_id: page,
        [filter]: filter === "all" ? undefined : true,
      },
      body: query ? { query } : undefined,
    });
    const items = Array.isArray(json?.aliases) ? json.aliases.map(simpleLoginAliasFromJson) : [];
    return { items, page, nextPage: items.length === SIMPLELOGIN_PAGE_SIZE ? page + 1 : undefined };
  }

  async get(id: number): Promise<SimpleLoginAlias> {
    const json = await this.transport.request<any>(this.settings, `api/aliases/${id}`);
    return simpleLoginAliasFromJson(json);
  }

  async update(id: number, update: UpdateSimpleLoginAliasRequest): Promise<SimpleLoginAlias> {
    await this.transport.request(this.settings, `api/aliases/${id}`, {
      method: "PATCH",
      body: {
        note: update.note,
        name: update.name,
        mailbox_ids: update.mailboxIds,
        disable_pgp: update.pgpDisabled,
        pinned: update.pinned,
      },
    });
    return this.get(id);
  }

  async setEnabled(id: number, enabled: boolean): Promise<SimpleLoginAlias> {
    const alias = await this.get(id);
    if (alias.enabled === enabled) {
      return alias;
    }

    const result = await this.transport.request<{ enabled?: boolean }>(
      this.settings,
      `api/aliases/${id}/toggle`,
      { method: "POST" },
    );
    return { ...alias, enabled: result.enabled === true };
  }

  async delete(id: number): Promise<void> {
    await this.transport.request(this.settings, `api/aliases/${id}`, { method: "DELETE" });
  }

  async domains(): Promise<SimpleLoginAliasDomain[]> {
    const json = await this.transport.request<any[]>(this.settings, "api/v2/setting/domains");
    return Array.isArray(json)
      ? json.map((domain) => ({
          domain: requiredString(domain?.domain, "alias domain"),
          isCustom: domain?.is_custom === true,
        }))
      : [];
  }

  async contacts(aliasId: number, page = 0): Promise<SimpleLoginContactPage> {
    const json = await this.transport.request<any>(
      this.settings,
      `api/aliases/${aliasId}/contacts`,
      { query: { page_id: page } },
    );
    const items = Array.isArray(json?.contacts)
      ? json.contacts.map(simpleLoginContactFromJson)
      : [];
    return { items, page, nextPage: items.length === SIMPLELOGIN_PAGE_SIZE ? page + 1 : undefined };
  }

  async createReverseAlias(aliasId: number, contact: string): Promise<SimpleLoginContact> {
    const json = await this.transport.request<any>(
      this.settings,
      `api/aliases/${aliasId}/contacts`,
      { method: "POST", body: { contact } },
    );
    return simpleLoginContactFromJson(json);
  }

  async toggleContactBlocked(contactId: number): Promise<boolean> {
    const json = await this.transport.request<{ block_forward?: boolean }>(
      this.settings,
      `api/contacts/${contactId}/toggle`,
      { method: "POST" },
    );
    return json.block_forward === true;
  }

  async deleteContact(contactId: number): Promise<void> {
    await this.transport.request(this.settings, `api/contacts/${contactId}`, {
      method: "DELETE",
    });
  }

  private async findByAddress(address: string): Promise<SimpleLoginAlias | undefined> {
    const result = await this.list(0, address);
    const normalized = normalizeEmailAliasAddress(address);
    return result.items.find((alias) => normalizeEmailAliasAddress(alias.address) === normalized);
  }
}

export function createSimpleLoginAliasService(
  api: ApiService,
  settings: SimpleLoginAliasSettings,
): SimpleLoginAliasService {
  return new SimpleLoginAliasService(new SimpleLoginAliasTransport(api), settings);
}
