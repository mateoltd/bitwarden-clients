import {
  AliasReference,
  CipherView as SdkCipherView,
  SensitiveString,
  bind_alias_reference,
  parse_alias_reference,
  serialize_alias_reference,
} from "@bitwarden/sdk-internal";

import {
  EmailAliasIdentity,
  normalizeEmailAliasAddress,
  parseEmailAliasIdentity,
  parseGeneratedCredentialMetadata,
} from "../../tools/alias";
import { CipherType, FieldType } from "../enums";
import { FieldView } from "../models/view/field.view";

/** Reserved encrypted custom-field name. It is removed before fields reach user-facing views. */
export const ALIAS_BINDING_FIELD_NAME = "bitwarden.alias.reference";
/** Pre-SDK first-class-client field. Read only to keep it hidden during canonical migration. */
export const LEGACY_ALIAS_BINDING_FIELD_NAME = "bitwarden.internal.alias-binding";

/** Versioned public identity persisted inside the encrypted cipher field path. */
export type AliasBinding = EmailAliasIdentity;

type AliasBindableCipher = {
  type: CipherType;
  login?: { username?: string | null };
  fields?: FieldView[];
  aliasBinding?: AliasBinding;
};

type RetainedLegacyField = { field: FieldView; address: string };
const retainedLegacyFields = new WeakMap<AliasBindableCipher, RetainedLegacyField[]>();

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

function parseBindingField(field: FieldView): AliasBinding | undefined {
  if (field.name !== ALIAS_BINDING_FIELD_NAME || !field.value) {
    return undefined;
  }

  try {
    return aliasBindingFromReference(parse_alias_reference(field.value));
  } catch {
    return undefined;
  }
}

function sanitizedLegacyField(field: FieldView): RetainedLegacyField | undefined {
  if (!field.value) {
    return undefined;
  }

  try {
    const value = JSON.parse(field.value) as Record<string, unknown>;
    let sanitized: Record<string, unknown>;
    if (
      field.name === ALIAS_BINDING_FIELD_NAME &&
      value.version === 1 &&
      value.provider === "simplelogin" &&
      typeof value.providerInstance === "string" &&
      typeof value.aliasId === "number" &&
      Number.isSafeInteger(value.aliasId) &&
      value.aliasId > 0 &&
      typeof value.address === "string" &&
      normalizeEmailAliasAddress(value.address) !== ""
    ) {
      sanitized = {
        version: 1,
        provider: "simplelogin",
        providerInstance: value.providerInstance,
        aliasId: value.aliasId,
        address: value.address,
      };
    } else if (
      field.name === LEGACY_ALIAS_BINDING_FIELD_NAME &&
      value.version === 1 &&
      value.provider === "simplelogin" &&
      typeof value.id === "string" &&
      /^[1-9]\d*$/.test(value.id) &&
      typeof value.address === "string" &&
      normalizeEmailAliasAddress(value.address) !== ""
    ) {
      sanitized = {
        version: 1,
        provider: "simplelogin",
        id: value.id,
        address: value.address,
      };
    } else {
      return undefined;
    }

    const retained = new FieldView();
    retained.type = FieldType.Hidden;
    retained.name = field.name;
    retained.value = JSON.stringify(sanitized);
    return { field: retained, address: value.address as string };
  } catch {
    return undefined;
  }
}

function isReservedAliasField(field: FieldView): boolean {
  return field.name === ALIAS_BINDING_FIELD_NAME || field.name === LEGACY_ALIAS_BINDING_FIELD_NAME;
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

function aliasBindingFromReference(reference: AliasReference): AliasBinding {
  return {
    version: 2,
    provider: reference.provider,
    providerInstance: reference.providerInstance,
    connectionId: reference.connectionId,
    aliasId: reference.aliasId.toString(),
    address: reference.address as string,
  };
}

/**
 * Extract the reserved field after decryption. Reserved fields are always hidden from ordinary
 * custom-field consumers, including when their payload is malformed.
 */
export function hydrateAliasBinding(cipher: AliasBindableCipher, candidate?: unknown): void {
  let binding = parseEmailAliasIdentity(candidate);
  const visibleFields: FieldView[] = [];
  const retained: RetainedLegacyField[] = [];

  for (const field of cipher.fields ?? []) {
    if (isReservedAliasField(field)) {
      if (field.name === ALIAS_BINDING_FIELD_NAME) {
        const parsed = parseBindingField(field);
        binding ??= parsed;
        if (!parsed) {
          const legacy = sanitizedLegacyField(field);
          if (legacy) {
            retained.push(legacy);
          }
        }
      } else {
        const legacy = sanitizedLegacyField(field);
        if (legacy) {
          retained.push(legacy);
        }
      }
    } else {
      visibleFields.push(field);
    }
  }

  cipher.fields = visibleFields;
  if (retained.length > 0) {
    retainedLegacyFields.set(cipher, retained);
  } else {
    retainedLegacyFields.delete(cipher);
  }
  if (
    cipher.type === CipherType.Login &&
    binding &&
    usernameMatches(binding, cipher.login?.username)
  ) {
    cipher.aliasBinding = binding;
  } else {
    delete cipher.aliasBinding;
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
    return undefined;
  }

  cipher.aliasBinding = binding;
  return binding;
}

/**
 * Materialize the binding as exactly one reserved field immediately before SDK encryption.
 * The returned array never mutates the user-visible field collection.
 */
export function fieldsWithAliasBinding(cipher: AliasBindableCipher): FieldView[] {
  const fields = fieldsWithoutAliasReferences(cipher);
  const binding = parseEmailAliasIdentity(cipher.aliasBinding);

  if (
    cipher.type !== CipherType.Login ||
    !binding ||
    !usernameMatches(binding, cipher.login?.username)
  ) {
    return fields;
  }

  const bindingField = new FieldView();
  bindingField.type = FieldType.Hidden;
  bindingField.name = ALIAS_BINDING_FIELD_NAME;
  bindingField.value = serialize_alias_reference(aliasReference(binding));
  return [...fields, bindingField];
}

/** Remove all reserved generations from the user field path before SDK validation/persistence. */
export function fieldsWithoutAliasReferences(cipher: AliasBindableCipher): FieldView[] {
  const visible = (cipher.fields ?? []).filter((field) => !isReservedAliasField(field));
  if (parseEmailAliasIdentity(cipher.aliasBinding)) {
    return visible;
  }

  const username = normalizeEmailAliasAddress(cipher.login?.username);
  const retained = (retainedLegacyFields.get(cipher) ?? [])
    .filter((entry) => normalizeEmailAliasAddress(entry.address) === username)
    .map((entry) => entry.field);
  return [...visible, ...retained];
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

  const encoded = serialize_alias_reference(aliasReference(binding));
  return bind_alias_reference(encoded, sdkCipher).cipher;
}
