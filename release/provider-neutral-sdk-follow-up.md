# Provider-neutral alias SDK follow-up

The provider-neutral alias wire and schema are owned by sibling branch
`refactor/provider-neutral-alias-v1`. This repair branch deliberately retains the currently pinned
public v1 SDK schema and does not define a competing wire format.

After the sibling SDK artifact is produced, the integration worktree must update these exact
client boundaries together:

1. Repin `@bitwarden/sdk-internal` and `@bitwarden/alias-sdk-internal` through
   `scripts/release/repin-sdk.mjs`, including the source commit, artifact digest, handoff, producer
   toolchain evidence, and lock entries in `release/alias-client-release.json`.
2. Replace the provider-specific public identity declarations and validation in
   `libs/common/src/tools/alias/email-alias.ts` only with the SDK-owned provider-neutral v1 types
   and parsers.
3. Update connection, identity, operation, and journal sanitization in
   `libs/common/src/tools/alias/alias-sync.ts` while preserving the durable reference transaction
   state machine added on this branch.
4. Update the SDK-to-client mapping in
   `libs/tools/generator/core/src/alias/simple-login-alias.service.ts` and
   `libs/tools/generator/core/src/alias/simple-login-alias.types.ts` without duplicating SDK wire
   definitions.
5. Update SDK reference creation, parsing, and cipher attachment in
   `libs/common/src/vault/alias-binding/alias-binding.ts`; retain full canonical identity equality
   in desktop bound-login lookup.
6. Update provider typing and report fields in
   `apps/cli/src/tools/alias-reconciliation/alias-reconciliation.service.ts`, plus browser,
   desktop, and web alias adapters that consume the shared identity.
7. Run the schema rejection, journal convergence, restart, cross-device, real provider, encrypted
   vault, clean-room, SBOM, and provenance gates before changing the manifest's declared alias
   schema version.
