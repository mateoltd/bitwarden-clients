import { EMAIL_ALIAS_IDENTITY_VERSION } from "../../tools/alias";
import { CipherType, FieldType } from "../enums";
import { CipherView } from "../models/view/cipher.view";
import { FieldView } from "../models/view/field.view";

import {
  ALIAS_BINDING_FIELD_NAME,
  bindGeneratedAlias,
  fieldsWithAliasBinding,
  fieldsWithoutAliasReferences,
  hydrateAliasBinding,
  reconcileAliasBinding,
} from "./alias-binding";

const firstAlias = {
  version: EMAIL_ALIAS_IDENTITY_VERSION,
  provider: "simplelogin" as const,
  providerInstance: "https://app.simplelogin.io/",
  connectionId: "11111111-1111-4111-8111-111111111111",
  aliasId: "41",
  address: "first@sl.test",
};

function login(username = firstAlias.address) {
  const cipher = new CipherView();
  cipher.type = CipherType.Login;
  cipher.login.username = username;
  return cipher;
}

describe("alias binding", () => {
  it("materializes and extracts one encrypted-path field without exposing it as a custom field", () => {
    const cipher = login();
    const userField = new FieldView();
    userField.name = "account";
    userField.value = "personal";
    cipher.fields = [userField];
    cipher.aliasBinding = firstAlias;

    const persistedFields = fieldsWithAliasBinding(cipher);

    expect(cipher.fields).toEqual([userField]);
    expect(persistedFields).toHaveLength(2);
    expect(persistedFields[1]).toMatchObject({
      name: ALIAS_BINDING_FIELD_NAME,
      type: FieldType.Hidden,
    });

    const restored = login();
    restored.fields = persistedFields;
    hydrateAliasBinding(restored);

    expect(restored.aliasBinding).toEqual(firstAlias);
    expect(restored.fields).toEqual([userField]);
  });

  it("replaces the binding when another alias is generated", () => {
    const cipher = login();
    cipher.aliasBinding = firstAlias;
    const secondAlias = { ...firstAlias, aliasId: "99", address: "second@sl.test" };
    cipher.login.username = secondAlias.address;

    bindGeneratedAlias(cipher, {
      credential: secondAlias.address,
      metadata: { kind: "email-alias", alias: secondAlias },
    });

    expect(cipher.aliasBinding).toEqual(secondAlias);
    expect(fieldsWithAliasBinding(cipher)).toHaveLength(1);
  });

  it("clears the binding when the username no longer represents the alias", () => {
    const cipher = login();
    cipher.aliasBinding = firstAlias;
    cipher.login.username = "someone@example.com";

    reconcileAliasBinding(cipher);

    expect(cipher.aliasBinding).toBeUndefined();
    expect(fieldsWithAliasBinding(cipher)).toEqual([]);
  });

  it("drops malformed reserved fields and rejects provider credentials", () => {
    const field = new FieldView();
    field.name = ALIAS_BINDING_FIELD_NAME;
    field.value = JSON.stringify({ ...firstAlias, token: "must-not-survive" });
    const cipher = login();
    cipher.fields = [field];

    hydrateAliasBinding(cipher);

    expect(cipher.fields).toEqual([]);
    expect(cipher.aliasBinding).toBeUndefined();
    expect(JSON.stringify(cipher)).not.toContain("must-not-survive");
  });

  it("keeps a sanitized pre-SDK field hidden until reconciliation replaces it", () => {
    const field = new FieldView();
    field.name = "bitwarden.internal.alias-binding";
    field.type = FieldType.Hidden;
    field.value = JSON.stringify({
      version: 1,
      provider: "simplelogin",
      id: "41",
      address: firstAlias.address,
      token: "must-not-survive",
    });
    const cipher = login();
    cipher.fields = [field];

    hydrateAliasBinding(cipher);

    expect(cipher.fields).toEqual([]);
    expect(cipher.aliasBinding).toBeUndefined();
    const retained = fieldsWithoutAliasReferences(cipher);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      name: "bitwarden.internal.alias-binding",
      type: FieldType.Hidden,
    });
    expect(retained[0].value).not.toContain("must-not-survive");
  });

  it("retains an SDK v1 field for explicit connection-scoped migration", () => {
    const field = new FieldView();
    field.name = ALIAS_BINDING_FIELD_NAME;
    field.type = FieldType.Hidden;
    field.value = JSON.stringify({
      version: 1,
      provider: "simplelogin",
      providerInstance: firstAlias.providerInstance,
      aliasId: 41,
      address: firstAlias.address,
    });
    const cipher = login();
    cipher.fields = [field];

    hydrateAliasBinding(cipher);

    expect(cipher.fields).toEqual([]);
    expect(cipher.aliasBinding).toBeUndefined();
    expect(fieldsWithoutAliasReferences(cipher)).toEqual([
      expect.objectContaining({
        name: ALIAS_BINDING_FIELD_NAME,
        type: FieldType.Hidden,
        value: field.value,
      }),
    ]);
  });

  it("property: canonical references round-trip for generated IDs, cases and addresses", () => {
    let state = 0x6d2b79f5;
    const next = () => {
      state = Math.imul(state ^ (state >>> 15), 1 | state);
      state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
      return ((state ^ (state >>> 14)) >>> 0) / 4_294_967_296;
    };

    for (let index = 0; index < 512; index++) {
      const local = `Alias-${index}-${Math.floor(next() * 1_000_000)}`;
      const address = `${local}@Example.Test`;
      const identity = {
        ...firstAlias,
        aliasId: String(index + 1),
        address,
      };
      const source = login(address.toUpperCase());
      source.aliasBinding = identity;

      const restored = login(address.toLowerCase());
      restored.fields = fieldsWithAliasBinding(source);
      hydrateAliasBinding(restored);

      expect(restored.aliasBinding).toEqual(identity);
      expect(restored.fields).toEqual([]);
    }
  });

  it("does not bind ordinary generated usernames", () => {
    const cipher = login("ordinary-user");

    bindGeneratedAlias(cipher, { credential: "ordinary-user" });

    expect(cipher.aliasBinding).toBeUndefined();
  });
});
