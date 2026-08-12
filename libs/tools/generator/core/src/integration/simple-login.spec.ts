import { mock } from "jest-mock-extended";

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
    it("should pass through deserialization", () => {
      const value: any = {};
      const result = SimpleLogin.forwarder.settings.deserializer(value);
      expect(result).toBe(value);
    });
  });

  describe("importBuffer", () => {
    it("should pass through deserialization", () => {
      const value: any = {};
      const result = SimpleLogin.forwarder.importBuffer.options.deserializer(value);
      expect(result).toBe(value);
    });
  });
  it("does not expose the legacy HTTP generator operation", () => {
    expect(SimpleLogin.forwarder.createForwardingEmail).toBeUndefined();
  });
});
