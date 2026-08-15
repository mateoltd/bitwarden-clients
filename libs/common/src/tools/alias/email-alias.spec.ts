import {
  EMAIL_ALIAS_IDENTITY_VERSION,
  emailAliasIdentitiesEqual,
  parseEmailAliasIdentity,
  parseGeneratedCredentialMetadata,
} from "./email-alias";

const validIdentity = {
  version: EMAIL_ALIAS_IDENTITY_VERSION,
  provider: "simplelogin" as const,
  providerInstance: "https://app.simplelogin.io/",
  connectionId: "11111111-1111-4111-8111-111111111111",
  aliasId: "41",
  address: "first@sl.test",
};

describe("email alias schema v1", () => {
  it("round-trips the first public reference schema", () => {
    expect(parseEmailAliasIdentity(validIdentity)).toEqual(validIdentity);
    expect(parseGeneratedCredentialMetadata({ kind: "email-alias", alias: validIdentity })).toEqual(
      { kind: "email-alias", alias: validIdentity },
    );
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["malformed", "1"],
    ["version 2", 2],
    ["unknown", 99],
  ])("rejects a %s schema version", (_name, version) => {
    const candidate = { ...validIdentity, version } as unknown;

    expect(parseEmailAliasIdentity(candidate)).toBeUndefined();
    expect(
      parseGeneratedCredentialMetadata({ kind: "email-alias", alias: candidate }),
    ).toBeUndefined();
  });

  it("rejects non-canonical records", () => {
    expect(parseEmailAliasIdentity({ ...validIdentity, connectionId: "invalid" })).toBeUndefined();
    expect(parseEmailAliasIdentity({ ...validIdentity, aliasId: "0" })).toBeUndefined();
    expect(parseEmailAliasIdentity({ ...validIdentity, address: "" })).toBeUndefined();
  });

  it("compares the complete connection-scoped identity", () => {
    expect(emailAliasIdentitiesEqual(validIdentity, { ...validIdentity })).toBe(true);
    expect(
      emailAliasIdentitiesEqual(validIdentity, {
        ...validIdentity,
        providerInstance: "https://other.simplelogin.example/",
      }),
    ).toBe(false);
    expect(
      emailAliasIdentitiesEqual(validIdentity, {
        ...validIdentity,
        connectionId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBe(false);
  });
});
