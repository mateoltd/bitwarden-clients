import {
  AliasReference,
  CipherView as SdkCipherView,
  SensitiveString,
  bind_alias_reference,
  parse_alias_reference,
  serialize_alias_reference,
} from "@bitwarden/alias-sdk-internal";

import {
  EmailAliasIdentity,
  normalizeEmailAliasAddress,
  parseEmailAliasIdentity,
  parseGeneratedCredentialMetadata,
} from "../../tools/alias";
import { CipherType } from "../enums";

/** Versioned public identity persisted inside the encrypted login payload. */
export type AliasBinding = EmailAliasIdentity;

type AliasBindableCipher = {
  type: CipherType;
  login?: { username?: string | null; aliasReference?: string | null };
  aliasBinding?: AliasBinding;
};

type GeneratedCredentialLike = {
  credential: string;
  metadata?: unknown;
};

function usernameMatches(binding: AliasBinding, username: string | null | undefined): boolean {
  return (
    normalizeEmailAliasAddress(username) !== "" &&
    normalizeEmailAliasAddress(binding.address) === normalizeEmailAliasAddress(username)
  );
}

function parseBindingReference(value: string | null | undefined): AliasBinding | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return aliasBindingFromReference(parse_alias_reference(value));
  } catch {
    return undefined;
  }
}

function aliasReference(binding: AliasBinding): AliasReference {
  return {
    version: binding.version,
    provider: binding.provider,
    providerInstance: binding.providerInstance,
    connectionId: binding.connectionId,
    aliasId: BigInt(binding.aliasId),
    address: binding.address as SensitiveString,
  };
}

function aliasBindingFromReference(reference: AliasReference): AliasBinding | undefined {
  return parseEmailAliasIdentity({
    version: reference.version,
    provider: reference.provider,
    providerInstance: reference.providerInstance,
    connectionId: reference.connectionId,
    aliasId: reference.aliasId.toString(),
    address: reference.address as string,
  });
}

/**
 * Parse the first-class reference after decryption. The reference is never inferred from a
 * username, and malformed payloads fail closed without touching unrelated custom fields.
 */
export function hydrateAliasBinding(cipher: AliasBindableCipher, candidate?: unknown): void {
  const binding =
    parseEmailAliasIdentity(candidate) ?? parseBindingReference(cipher.login?.aliasReference);
  if (
    cipher.type === CipherType.Login &&
    binding &&
    usernameMatches(binding, cipher.login?.username)
  ) {
    cipher.aliasBinding = binding;
    if (cipher.login) {
      cipher.login.aliasReference = serialize_alias_reference(aliasReference(binding));
    }
  } else {
    delete cipher.aliasBinding;
    if (cipher.login) {
      cipher.login.aliasReference = undefined;
    }
  }
}

/** Clear a binding as soon as the login username no longer represents its alias address. */
export function reconcileAliasBinding(cipher: AliasBindableCipher): void {
  if (
    cipher.type !== CipherType.Login ||
    !cipher.aliasBinding ||
    !usernameMatches(cipher.aliasBinding, cipher.login?.username)
  ) {
    delete cipher.aliasBinding;
    if (cipher.login) {
      cipher.login.aliasReference = undefined;
    }
  }
}

/** Replace the login's current binding with identity carried by a generated alias. */
export function bindGeneratedAlias(
  cipher: AliasBindableCipher,
  generated: GeneratedCredentialLike,
): AliasBinding | undefined {
  const metadata = parseGeneratedCredentialMetadata(generated.metadata);
  const binding = metadata?.alias;

  if (
    cipher.type !== CipherType.Login ||
    !binding ||
    normalizeEmailAliasAddress(generated.credential) !==
      normalizeEmailAliasAddress(binding.address) ||
    normalizeEmailAliasAddress(cipher.login?.username) !==
      normalizeEmailAliasAddress(binding.address)
  ) {
    delete cipher.aliasBinding;
    if (cipher.login) {
      cipher.login.aliasReference = undefined;
    }
    return undefined;
  }

  cipher.aliasBinding = binding;
  if (cipher.login) {
    cipher.login.aliasReference = serialize_alias_reference(aliasReference(binding));
  }
  return binding;
}

/** Let the canonical SDK validate and attach the reference to a decrypted SDK cipher view. */
export function bindAliasReferenceToSdkCipher(
  cipher: AliasBindableCipher,
  sdkCipher: SdkCipherView,
): SdkCipherView {
  const binding = parseEmailAliasIdentity(cipher.aliasBinding);
  if (
    cipher.type !== CipherType.Login ||
    !binding ||
    !usernameMatches(binding, cipher.login?.username)
  ) {
    if (sdkCipher.login) {
      sdkCipher.login.aliasReference = undefined;
    }
    return sdkCipher;
  }

  const encoded = serialize_alias_reference(aliasReference(binding));
  return bind_alias_reference(encoded, sdkCipher).cipher;
}
