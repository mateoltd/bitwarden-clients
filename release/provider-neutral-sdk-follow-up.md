# Provider-neutral alias SDK follow-up

The provider-neutral alias wire and schema are owned by the public SDK source branch
`integration/provider-neutral-alias-upstream-sync`. This client state is based on upstream commit
`b52a472fccba2727cba9cd22257d551599c43e4f` and pins the provenance-complete
`0.3.0-alias-provider-neutral.1` candidate from SDK commit
`106aad00f85fb0766c2d5ede534a39b792f48789`, release-candidate run `32362581586`, and candidate
artifact `9405727965`. The candidate preserves the provider-neutral v1 alias contract and includes
the compatibility APIs from upstream SDK `0.2.0-main.971`. It does not substitute Bitwarden's
unqualified SDK package or define a competing wire format.

The compatibility repin updates these client boundaries together:

1. Repin `@bitwarden/sdk-internal` and `@bitwarden/alias-sdk-internal` through
   `scripts/release/repin-sdk.mjs`, including the source commit, artifact digest, handoff, producer
   toolchain evidence, and lock entries in `release/alias-client-release.json`. Update the explicit
   commercial overlay to verified `0.2.0-main.971` evidence without adding it to the public default
   dependency graph.
2. Adopt the upstream key-management contract as one atomic change: remove the client-managed
   `user_key_state` and `ephemeral_pin_envelope_state` repositories, migrate the state bridge from
   record-shaped values to direct values, add `KeyId` state bridge storage, and pass
   `UpgradeTokenAction` to trust discovery. Add `open_org_invite` to the SDK registration request
   and restore the SDK-flow registration context tests. The qualified candidate must expose all of
   those APIs before these client changes land.
3. Replace the provider-specific public identity declarations and validation in
   `libs/common/src/tools/alias/email-alias.ts` only with the SDK-owned provider-neutral v1 types
   and parsers.
4. Update connection, identity, operation, and journal sanitization in
   `libs/common/src/tools/alias/alias-sync.ts` while preserving the durable reference transaction
   state machine added on this branch.
5. Update the SDK-to-client mapping in
   `libs/tools/generator/core/src/alias/simple-login-alias.service.ts` and
   `libs/tools/generator/core/src/alias/simple-login-alias.types.ts` without duplicating SDK wire
   definitions.
6. Update SDK reference creation, parsing, and cipher attachment in
   `libs/common/src/vault/alias-binding/alias-binding.ts`; retain full canonical identity equality
   in desktop bound-login lookup.
7. Update provider typing and report fields in
   `apps/cli/src/tools/alias-reconciliation/alias-reconciliation.service.ts`, plus browser,
   desktop, and web alias adapters that consume the shared identity.
8. Run the schema rejection, journal convergence, restart, cross-device, real provider, encrypted
   vault, clean-room, SBOM, and provenance gates without changing the manifest's declared alias
   schema version.
