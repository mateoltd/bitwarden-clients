import { EMAIL_ALIAS_IDENTITY_VERSION } from "../../tools/alias";
import { CipherType, FieldType } from "../enums";
import { CipherView } from "../models/view/cipher.view";
import { FieldView } from "../models/view/field.view";

import {
  ALIAS_BINDING_FIELD_NAME,
  bindGeneratedAlias,
  fieldsWithAliasBinding,
  hydrateAliasBinding,
  reconcileAliasBinding,
} from "./alias-binding";

const firstAlias = {
  version: EMAIL_ALIAS_IDENTITY_VERSION,
  provider: "simplelogin" as const,
  id: "41",
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
    const secondAlias = { ...firstAlias, id: "99", address: "second@sl.test" };
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

  it("drops malformed reserved fields and provider credentials", () => {
    const field = new FieldView();
    field.name = ALIAS_BINDING_FIELD_NAME;
    field.value = JSON.stringify({ ...firstAlias, token: "must-not-survive" });
    const cipher = login();
    cipher.fields = [field];

    hydrateAliasBinding(cipher);

    expect(cipher.fields).toEqual([]);
    expect(cipher.aliasBinding).toEqual(firstAlias);
    expect(JSON.stringify(cipher.aliasBinding)).not.toContain("must-not-survive");
  });

  it("does not bind ordinary generated usernames", () => {
    const cipher = login("ordinary-user");

    bindGeneratedAlias(cipher, { credential: "ordinary-user" });

    expect(cipher.aliasBinding).toBeUndefined();
  });
});
