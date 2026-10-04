declare module "@bitwarden/sdk-internal" {
  // In `bit-*` clients the commercial sdk replaces the regular internal sdk,
  // this file creates an alias so that typescript understands that.
  // The actual replacement is done in the build system via webpack's resolve.alias.
  // eslint-disable-next-line no-restricted-imports
  export * from "@bitwarden/commercial-sdk-internal";

  /** Public alias fields added to the compatible commercial SDK login shape. */
  export type Login = import("@bitwarden/commercial-sdk-internal").Login & {
    aliasReference?: import("@bitwarden/alias-sdk-internal").Login["aliasReference"];
  };

  /** Public alias fields added to the compatible commercial SDK decrypted login shape. */
  export type LoginView = import("@bitwarden/commercial-sdk-internal").LoginView & {
    aliasReference?: import("@bitwarden/alias-sdk-internal").LoginView["aliasReference"];
  };

  /** Preserve the commercial cipher view while exposing its public alias-aware login member. */
  export type CipherView = Omit<
    import("@bitwarden/commercial-sdk-internal").CipherView,
    "login"
  > & {
    login: LoginView | undefined;
  };
}
