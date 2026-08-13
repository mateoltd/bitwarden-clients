import { EMAIL_ALIAS_IDENTITY_VERSION } from "../../tools/alias";
import { CipherType } from "../enums";
import { CipherView } from "../models/view/cipher.view";
import { FieldView } from "../models/view/field.view";

import { bindGeneratedAlias, hydrateAliasBinding, reconcileAliasBinding } from "./alias-binding";

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

function bind(cipher: CipherView, alias = firstAlias) {
  return bindGeneratedAlias(cipher, {
    credential: alias.address,
    metadata: { kind: "email-alias", alias },
  });
}

describe("alias binding", () => {
  it("persists through the first-class login member without touching custom fields", () => {
    const cipher = login();
    const userField = new FieldView();
    userField.name = "account";
    userField.value = "visible";
    cipher.fields = [userField];

    expect(bind(cipher)).toEqual(firstAlias);
    expect(cipher.login.aliasReference).toContain('"version":1');
    expect(cipher.fields).toEqual([userField]);

    const restored = login();
    restored.login.aliasReference = cipher.login.aliasReference;
    restored.fields = [userField];
    hydrateAliasBinding(restored);

    expect(restored.aliasBinding).toEqual(firstAlias);
    expect(restored.fields).toEqual([userField]);
  });

  it("replaces the binding when another alias is explicitly generated", () => {
    const cipher = login();
    bind(cipher);
    const secondAlias = { ...firstAlias, aliasId: "99", address: "second@sl.test" };
    cipher.login.username = secondAlias.address;

    bind(cipher, secondAlias);

    expect(cipher.aliasBinding).toEqual(secondAlias);
    expect(cipher.login.aliasReference).toContain('"aliasId":99');
  });

  it("clears the binding when the username no longer represents the alias", () => {
    const cipher = login();
    bind(cipher);
    cipher.login.username = "someone@example.com";

    reconcileAliasBinding(cipher);

    expect(cipher.aliasBinding).toBeUndefined();
    expect(cipher.login.aliasReference).toBeUndefined();
  });

  it("drops malformed references without removing unrelated custom fields or retaining secrets", () => {
    const userField = new FieldView();
    userField.name = "account";
    userField.value = "visible";
    const cipher = login();
    cipher.fields = [userField];
    cipher.login.aliasReference = JSON.stringify({ ...firstAlias, token: "must-not-survive" });

    hydrateAliasBinding(cipher);

    expect(cipher.fields).toEqual([userField]);
    expect(cipher.aliasBinding).toBeUndefined();
    expect(cipher.login.aliasReference).toBeUndefined();
    expect(JSON.stringify(cipher)).not.toContain("must-not-survive");
  });

  it("rejects malformed and unreleased reference versions", () => {
    const malformed = login();
    malformed.login.aliasReference = JSON.stringify({ ...firstAlias, connectionId: "invalid" });
    hydrateAliasBinding(malformed);
    expect(malformed.aliasBinding).toBeUndefined();
    expect(malformed.login.aliasReference).toBeUndefined();

    const future = login();
    future.login.aliasReference = JSON.stringify({ ...firstAlias, version: 2 });
    hydrateAliasBinding(future);
    expect(future.aliasBinding).toBeUndefined();
    expect(future.login.aliasReference).toBeUndefined();
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
      const identity = { ...firstAlias, aliasId: String(index + 1), address };
      const source = login(address.toUpperCase());
      bind(source, identity);

      const restored = login(address.toLowerCase());
      restored.login.aliasReference = source.login.aliasReference;
      hydrateAliasBinding(restored);

      expect(restored.aliasBinding).toEqual(identity);
      expect(restored.fields).toEqual([]);
    }
  });

  it("does not bind ordinary generated usernames", () => {
    const cipher = login("ordinary-user");

    bindGeneratedAlias(cipher, { credential: "ordinary-user" });

    expect(cipher.aliasBinding).toBeUndefined();
    expect(cipher.login.aliasReference).toBeUndefined();
  });
});
