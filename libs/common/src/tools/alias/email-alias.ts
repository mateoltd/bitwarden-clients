import { AliasIdentity, parse_alias_reference } from "@bitwarden/alias-sdk-internal";

/** First public SDK alias-reference version exchanged by generators and vault ciphers. */
export const EMAIL_ALIAS_IDENTITY_VERSION = 1 as const;

/**
 * Stable, non-secret provider-neutral identity for an email alias.
 *
 * The SDK owns this public shape and its validation. Adapter identifiers, endpoints, and provider
 * credentials deliberately remain outside it.
 */
export type EmailAliasIdentity = AliasIdentity;

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
    left.connectionId === right.connectionId &&
    left.aliasId === right.aliasId &&
    normalizeEmailAliasAddress(left.address) === normalizeEmailAliasAddress(right.address)
  );
}

/** Parse an untrusted alias identity exclusively through the SDK's canonical v1 parser. */
export function parseEmailAliasIdentity(value: unknown): EmailAliasIdentity | undefined {
  try {
    return parse_alias_reference(JSON.stringify(value));
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
  if (
    candidate.kind !== "email-alias" ||
    Object.keys(candidate).some((key) => key !== "kind" && key !== "alias")
  ) {
    return undefined;
  }

  const alias = parseEmailAliasIdentity(candidate.alias);
  return alias ? { kind: "email-alias", alias } : undefined;
}
