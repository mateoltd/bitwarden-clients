import { create_alias_reference } from "@bitwarden/alias-sdk-internal";

import { EMAIL_ALIAS_IDENTITY_VERSION } from "../../tools/alias";
import { CipherType } from "../enums";
import { CipherView } from "../models/view/cipher.view";
import { FieldView } from "../models/view/field.view";

import { bindGeneratedAlias, hydrateAliasBinding, reconcileAliasBinding } from "./alias-binding";

const firstAlias = {
  version: EMAIL_ALIAS_IDENTITY_VERSION,
  connectionId: "11111111-1111-4111-8111-111111111111",
  aliasId: "opaque:41",
  address: "first@sl.test",
};

function login(username = firstAlias.address) {
  const cipher = new CipherView();
  cipher.type = CipherType.Login;
  cipher.login.username = username;
  return cipher;
}

describe("alias binding", () => {
  it("round-trips the SDK-owned first-class login member without a custom-field carrier", () => {
    const source = login();
    const userField = new FieldView();
    userField.name = "account";
    userField.value = "visible";
    source.fields = [userField];

    bindGeneratedAlias(source, {
      credential: firstAlias.address,
      metadata: { kind: "email-alias", alias: firstAlias },
    });

    expect(source.login.aliasReference).toBe(create_alias_reference(firstAlias));
    expect(source.fields).toEqual([userField]);

    const restored = login();
    restored.fields = [userField];
    restored.login.aliasReference = source.login.aliasReference;
    hydrateAliasBinding(restored);

    expect(restored.aliasBinding).toEqual(firstAlias);
    expect(restored.fields).toEqual([userField]);
  });

  it("replaces a binding with exact connectionId plus opaque aliasId identity", () => {
    const cipher = login();
    const secondAlias = { ...firstAlias, aliasId: "opaque:99", address: "second@sl.test" };
    cipher.login.username = secondAlias.address;

    bindGeneratedAlias(cipher, {
      credential: secondAlias.address,
      metadata: { kind: "email-alias", alias: secondAlias },
    });

    expect(cipher.aliasBinding).toEqual(secondAlias);
    expect(cipher.login.aliasReference).toBe(create_alias_reference(secondAlias));
  });

  it("clears the first-class member when the username no longer matches", () => {
    const cipher = login();
    cipher.aliasBinding = firstAlias;
    cipher.login.aliasReference = create_alias_reference(firstAlias);
    cipher.login.username = "someone@example.com";

    reconcileAliasBinding(cipher);

    expect(cipher.aliasBinding).toBeUndefined();
    expect(cipher.login.aliasReference).toBeUndefined();
  });

  it("restores the first-class member after a form rebuild preserves the canonical identity", () => {
    const cipher = login();
    cipher.aliasBinding = firstAlias;
    cipher.login.aliasReference = undefined;

    reconcileAliasBinding(cipher);

    expect(cipher.login.aliasReference).toBe(create_alias_reference(firstAlias));
  });

  it.each([
    JSON.stringify({ ...firstAlias, token: "must-not-survive" }),
    JSON.stringify({ ...firstAlias, version: 2 }),
    JSON.stringify({ ...firstAlias, connectionId: "invalid" }),
    JSON.stringify({ ...firstAlias, aliasId: 41 }),
  ])("quarantines a malformed or non-canonical reference", (reference) => {
    const cipher = login();
    cipher.login.aliasReference = reference;

    hydrateAliasBinding(cipher);

    expect(cipher.aliasBinding).toBeUndefined();
    expect(cipher.login.aliasReference).toBeUndefined();
    expect(JSON.stringify(cipher)).not.toContain("must-not-survive");
  });

  it("property: canonical references round-trip across address casing", () => {
    let state = 0x6d2b79f5;
    const next = () => {
      state = Math.imul(state ^ (state >>> 15), 1 | state);
      state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
      return ((state ^ (state >>> 14)) >>> 0) / 4_294_967_296;
    };

    for (let index = 0; index < 512; index++) {
      const address = `alias-${index}-${Math.floor(next() * 1_000_000)}@example.test`;
      const identity = { ...firstAlias, aliasId: `opaque:${index}`, address };
      const source = login(address.toUpperCase());
      bindGeneratedAlias(source, {
        credential: address,
        metadata: { kind: "email-alias", alias: identity },
      });

      const restored = login(address.toLowerCase());
      restored.login.aliasReference = source.login.aliasReference;
      hydrateAliasBinding(restored);

      expect(restored.aliasBinding).toEqual(identity);
    }
  });

  it("does not bind ordinary generated usernames", () => {
    const cipher = login("ordinary-user");
    bindGeneratedAlias(cipher, { credential: "ordinary-user" });
    expect(cipher.aliasBinding).toBeUndefined();
    expect(cipher.login.aliasReference).toBeUndefined();
  });
});
