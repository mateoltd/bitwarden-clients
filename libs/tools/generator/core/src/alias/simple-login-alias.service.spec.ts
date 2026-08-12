import { createSimpleLoginAliasService } from "./simple-login-alias.service";

const connectionId = "11111111-1111-4111-8111-111111111111";

describe("SimpleLoginAliasService", () => {
  it.each([
    "http://simplelogin.example",
    "ftp://simplelogin.example",
    "https://user:password@simplelogin.example",
    "https://simplelogin.example?destination=untrusted",
  ])("lets the SDK reject an unsafe provider URL before any request: %s", (baseUrl) => {
    expect(() =>
      createSimpleLoginAliasService({ token: "provider-secret", baseUrl, connectionId }),
    ).toThrow(expect.objectContaining({ code: "invalid-response" }));
  });

  it("allows the SDK's loopback-only HTTP integration exception", () => {
    const service = createSimpleLoginAliasService({
      token: "provider-secret",
      baseUrl: "http://127.0.0.1:32769",
      connectionId,
    });

    expect(service.providerIdentity()).toEqual({
      provider: "simplelogin",
      instance: "http://127.0.0.1:32769/",
      connectionId,
    });
  });

  it("rejects malformed connection identities instead of silently replacing them", () => {
    expect(() =>
      createSimpleLoginAliasService({
        token: "provider-secret",
        baseUrl: "https://app.simplelogin.io",
        connectionId: "not-a-uuid",
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-response" }));
  });

  it("never copies an invalid provider token into the translated error", () => {
    const token = "private-token\nnot-a-header";
    try {
      createSimpleLoginAliasService({ token, connectionId });
      throw new Error("expected SDK validation to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid-response" });
      expect((error as Error).message).not.toContain(token);
    }
  });

  it("rejects invalid numeric identifiers before crossing the WASM boundary", async () => {
    const service = createSimpleLoginAliasService({
      token: "provider-secret",
      connectionId,
    });

    await expect(service.get(-1)).rejects.toMatchObject({
      code: "invalid-response",
      message: "SimpleLogin alias id is invalid",
    });
    await expect(service.contacts(1, -1)).rejects.toMatchObject({
      code: "invalid-response",
      message: "SimpleLogin page is invalid",
    });
  });
});
