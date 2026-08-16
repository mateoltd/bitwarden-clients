import {
  CipherView as SdkCipherView,
  bind_alias_reference,
  create_alias_reference,
  parse_alias_reference,
} from "@bitwarden/alias-sdk-internal";

import {
  EmailAliasIdentity,
  normalizeEmailAliasAddress,
  parseEmailAliasIdentity,
  parseGeneratedCredentialMetadata,
} from "../../tools/alias";
import { CipherType } from "../enums";

/** Versioned public identity persisted inside the encrypted cipher field path. */
export type AliasBinding = EmailAliasIdentity;

type AliasBindableCipher = {
  type: CipherType;
  login?: { username?: string | null; aliasReference?: string };
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

function parseBindingReference(value: unknown): AliasBinding | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    return parse_alias_reference(value);
  } catch {
    return undefined;
  }
}

/**
 * Hydrate the transient UI binding from the SDK-owned first-class encrypted login member.
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
      cipher.login.aliasReference = create_alias_reference(binding);
    }
  } else {
    delete cipher.aliasBinding;
    if (cipher.login && typeof cipher.login === "object") {
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
    return;
  }

  if (cipher.login) {
    cipher.login.aliasReference = create_alias_reference(cipher.aliasBinding);
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
  cipher.login.aliasReference = create_alias_reference(binding);
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
    return sdkCipher;
  }

  const encoded = create_alias_reference(binding);
  return bind_alias_reference(encoded, sdkCipher).cipher;
}
