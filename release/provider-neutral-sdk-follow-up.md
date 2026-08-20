# Provider-neutral alias SDK follow-up

The provider-neutral alias wire and schema are owned by sibling branch
`refactor/provider-neutral-alias-v1`. The upstream client sync at
`660766841b566440e1faaeeb92aecc26e1503bed` deliberately retains the currently verified
`0.3.0-alias-provider-neutral.1` artifact from SDK commit
`99c33ed26e51421224a4daecdf838057f1d66e75`. It does not substitute Bitwarden's unqualified
`0.2.0-main.971` package or define a competing wire format.

The next repin must use a public, provenance-complete provider-neutral candidate that preserves the
v1 alias contract and incorporates the SDK compatibility required by upstream
`0.2.0-main.971`. Do not repin until that qualified candidate exists. Then update these exact client
boundaries together:

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
   vault, clean-room, SBOM, and provenance gates before changing the manifest's declared alias
   schema version.
