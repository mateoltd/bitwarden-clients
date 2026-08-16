import { SendReplyIdentity } from "@bitwarden/alias-sdk-internal";
import {
  AliasSyncStore,
  EmailAliasCredentialMetadata,
  EmailAliasIdentity,
} from "@bitwarden/common/tools/alias";

export type SimpleLoginAliasSettings = {
  token: string;
  baseUrl?: string;
  /** Stable UUID v4 persisted with the encrypted account-scoped provider settings. */
  connectionId: string;
  /** Encrypted crash/offline journal used by every production client path. */
  syncStore?: AliasSyncStore;
};

export type SimpleLoginMailbox = {
  id: number;
  email: string;
};

export type SimpleLoginAliasActivity = {
  action: "forward" | "reply" | "block" | "bounced";
  timestamp: number;
  contact: {
    email: string;
    name: string | null;
    reverseAlias: string;
  };
};

export type SimpleLoginAlias = {
  id: number;
  address: string;
  name: string | null;
  note: string | null;
  enabled: boolean;
  pinned: boolean;
  createdAt: number;
  blockedCount: number;
  forwardedCount: number;
  repliedCount: number;
  supportsPgp: boolean;
  pgpDisabled: boolean;
  mailboxes: SimpleLoginMailbox[];
  latestActivity: SimpleLoginAliasActivity | null;
  /** Canonical connection-scoped reference used by generator-to-vault binding. */
  identity: EmailAliasIdentity;
};

export type SimpleLoginAliasFilter = "all" | "enabled" | "disabled" | "pinned";

export type SimpleLoginAliasPage = {
  items: SimpleLoginAlias[];
  page: number;
  nextPage?: number;
};

export type SimpleLoginAliasSuffix = {
  suffix: string;
  signedSuffix: string;
  isCustom: boolean;
  isPremium: boolean;
};

export type SimpleLoginAliasRecommendation = {
  hostname: string;
  canCreate: boolean;
  prefixSuggestion: string;
  suffixes: SimpleLoginAliasSuffix[];
  alias?: SimpleLoginAlias;
};

export type CreateSimpleLoginAliasRequest =
  | {
      kind?: "random";
      hostname?: string;
      mode?: "uuid" | "word";
      note?: string;
    }
  | {
      kind: "custom";
      hostname?: string;
      aliasPrefix: string;
      signedSuffix: string;
      mailboxIds: number[];
      note?: string;
      name?: string;
    };

export type UpdateSimpleLoginAliasRequest = {
  note?: string | null;
  name?: string | null;
  mailboxIds?: number[];
  pgpDisabled?: boolean;
  pinned?: boolean;
};

export type SimpleLoginAliasDomain = {
  domain: string;
  isCustom: boolean;
};

export type SimpleLoginContact = {
  id: number;
  address: string;
  reverseAlias: string;
  reverseAliasAddress: string;
  createdAt: number;
  lastEmailSentAt: number | null;
  blocked: boolean;
  existed: boolean;
  /** Provider-neutral SDK identity required for mutation across lock and process boundaries. */
  identity: SendReplyIdentity;
};

export type SimpleLoginContactPage = {
  items: SimpleLoginContact[];
  page: number;
  nextPage?: number;
};

export function toSimpleLoginAliasIdentity(alias: SimpleLoginAlias): EmailAliasIdentity {
  return alias.identity;
}

export function toSimpleLoginCredentialMetadata(
  alias: SimpleLoginAlias,
): EmailAliasCredentialMetadata {
  return { kind: "email-alias", alias: toSimpleLoginAliasIdentity(alias) };
}
