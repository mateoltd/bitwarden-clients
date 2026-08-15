import {
  AliasReference,
  SensitiveString,
  serialize_alias_reference,
} from "@bitwarden/alias-sdk-internal";

/** First public SDK alias-reference version exchanged by generators and vault ciphers. */
export const EMAIL_ALIAS_IDENTITY_VERSION = 1 as const;

/** Providers whose aliases can be bound to a login cipher. */
export type EmailAliasProvider = "simplelogin";

/**
 * Stable, non-secret identity for an email alias.
 *
 * Provider credentials are deliberately not part of this type. Keep this shape safe to place in
 * an encrypted vault custom field and to pass through generator UI events.
 */
export type EmailAliasIdentity = {
  version: typeof EMAIL_ALIAS_IDENTITY_VERSION;
  provider: EmailAliasProvider;
  providerInstance: string;
  connectionId: string;
  aliasId: string;
  address: string;
};

/** Metadata attached to a generated credential when it represents a provider-backed alias. */
export type EmailAliasCredentialMetadata = {
  kind: "email-alias";
  alias: EmailAliasIdentity;
};

export type GeneratedCredentialMetadata = EmailAliasCredentialMetadata;

/** Normalize addresses for identity comparisons without changing the address saved in the vault. */
export function normalizeEmailAliasAddress(address: string | null | undefined): string {
  return address?.trim().toLowerCase() ?? "";
}

/** Compare every field in the canonical v1 connection-scoped identity. */
export function emailAliasIdentitiesEqual(
  left: EmailAliasIdentity,
  right: EmailAliasIdentity,
): boolean {
  return (
    left.version === right.version &&
    left.provider === right.provider &&
    left.providerInstance === right.providerInstance &&
    left.connectionId === right.connectionId &&
    left.aliasId === right.aliasId &&
    normalizeEmailAliasAddress(left.address) === normalizeEmailAliasAddress(right.address)
  );
}

/** Parse an untrusted alias identity while retaining only the public, versioned fields. */
export function parseEmailAliasIdentity(value: unknown): EmailAliasIdentity | undefined {
  if (value == null || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<Record<keyof EmailAliasIdentity, unknown>>;
  if (
    candidate.version !== EMAIL_ALIAS_IDENTITY_VERSION ||
    candidate.provider !== "simplelogin" ||
    typeof candidate.providerInstance !== "string" ||
    typeof candidate.connectionId !== "string" ||
    typeof candidate.aliasId !== "string" ||
    !/^[1-9]\d*$/.test(candidate.aliasId) ||
    typeof candidate.address !== "string" ||
    normalizeEmailAliasAddress(candidate.address) === ""
  ) {
    return undefined;
  }

  try {
    const reference: AliasReference = {
      version: EMAIL_ALIAS_IDENTITY_VERSION,
      provider: candidate.provider,
      providerInstance: candidate.providerInstance,
      connectionId: candidate.connectionId,
      aliasId: BigInt(candidate.aliasId),
      address: candidate.address.trim() as SensitiveString,
    };
    serialize_alias_reference(reference);
    return {
      version: EMAIL_ALIAS_IDENTITY_VERSION,
      provider: reference.provider,
      providerInstance: reference.providerInstance,
      connectionId: reference.connectionId,
      aliasId: reference.aliasId.toString(),
      address: reference.address as string,
    };
  } catch {
    return undefined;
  }
}

/** Parse generated-credential metadata without accepting provider-specific secrets. */
export function parseGeneratedCredentialMetadata(
  value: unknown,
): GeneratedCredentialMetadata | undefined {
  if (value == null || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as { kind?: unknown; alias?: unknown };
  if (candidate.kind !== "email-alias") {
    return undefined;
  }

  const alias = parseEmailAliasIdentity(candidate.alias);
  return alias ? { kind: "email-alias", alias } : undefined;
}
