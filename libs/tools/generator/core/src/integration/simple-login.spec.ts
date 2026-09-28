import { mock } from "jest-mock-extended";

import { createAliasSyncDocument } from "@bitwarden/common/tools/alias";

import { ForwarderContext } from "../engine";

import { SimpleLogin, SimpleLoginSettings } from "./simple-login";

describe("SimpleLogin forwarder", () => {
  const context = mock<ForwarderContext<SimpleLoginSettings>>();

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("authenticate", () => {
    it("returns a bearer header with the token", () => {
      context.authenticationToken.mockReturnValue("token");

      const result = SimpleLogin.authenticate(null, context);

      expect(result).toEqual({ Authentication: "token" });
      expect(context.authenticationToken).toHaveBeenCalled();
    });
  });

  describe("settings", () => {
    it("deserializes ordinary settings", () => {
      const value: any = {};
      const result = SimpleLogin.forwarder.settings.deserializer(value);
      expect(result).toEqual(value);
    });

    it("canonically reparses a persisted alias journal", () => {
      const aliasSync = createAliasSyncDocument("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

      expect(SimpleLogin.forwarder.settings.deserializer({ aliasSync } as never)).toEqual({
        aliasSync,
      });
      expect(() =>
        SimpleLogin.forwarder.settings.deserializer({
          aliasSync: { ...aliasSync, provider: "simplelogin" },
        } as never),
      ).toThrow("Invalid alias sync document");
    });
  });

  describe("importBuffer", () => {
    it("should pass through deserialization", () => {
      const value: any = {};
      const result = SimpleLogin.forwarder.importBuffer.options.deserializer(value);
      expect(result).toEqual(value);
    });
  });
  it("does not expose the legacy HTTP generator operation", () => {
    expect(SimpleLogin.forwarder.createForwardingEmail).toBeUndefined();
  });
});
