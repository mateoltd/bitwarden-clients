# Provider-neutral alias SDK compatibility

The canonical SDK is `0.3.0-alias-provider-neutral.2` from public source
`5562c7eafe6826594e4096d6d0d77ac9668b8bfe` on `integration/alias-sdk-launch-20260926`,
[hosted run 36289197668](https://github.com/mateoltd/bitwarden-sdk-internal/actions/runs/36289197668),
artifact `10922176671`. Its signed provenance and exact package bytes are pinned together in
`release/alias-client-release.json`. This clients branch retains frozen upstream
`45eb0013dc413dab78932c418d209d89371febf6` and the current `.1051` SDK API requirements.
The provider-neutral alias v1 contract remains unchanged.

The following checklist records the earlier `.971` compatibility migration; its package/source
coordinates are historical, not the current pin. Current clients retain the newer upstream APIs.

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
