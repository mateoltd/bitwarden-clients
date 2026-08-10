import {
  EmailAliasIdentity,
  normalizeEmailAliasAddress,
  parseEmailAliasIdentity,
  parseGeneratedCredentialMetadata,
} from "../../tools/alias";
import { CipherType, FieldType } from "../enums";
import { FieldView } from "../models/view/field.view";

/** Reserved encrypted custom-field name. It is removed before fields reach user-facing views. */
export const ALIAS_BINDING_FIELD_NAME = "bitwarden.internal.alias-binding";

/** Versioned public identity persisted inside the encrypted cipher field path. */
export type AliasBinding = EmailAliasIdentity;

type AliasBindableCipher = {
  type: CipherType;
  login?: { username?: string | null };
  fields?: FieldView[];
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

function parseBindingField(field: FieldView): AliasBinding | undefined {
  if (field.name !== ALIAS_BINDING_FIELD_NAME || !field.value) {
    return undefined;
  }

  try {
    return parseEmailAliasIdentity(JSON.parse(field.value));
  } catch {
    return undefined;
  }
}

/**
 * Extract the reserved field after decryption. Reserved fields are always hidden from ordinary
 * custom-field consumers, including when their payload is malformed.
 */
export function hydrateAliasBinding(cipher: AliasBindableCipher, candidate?: unknown): void {
  let binding = parseEmailAliasIdentity(candidate);
  const visibleFields: FieldView[] = [];

  for (const field of cipher.fields ?? []) {
    if (field.name === ALIAS_BINDING_FIELD_NAME) {
      binding ??= parseBindingField(field);
    } else {
      visibleFields.push(field);
    }
  }

  cipher.fields = visibleFields;
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
  const fields = (cipher.fields ?? []).filter((field) => field.name !== ALIAS_BINDING_FIELD_NAME);
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
  bindingField.value = JSON.stringify(binding);
  return [...fields, bindingField];
}
