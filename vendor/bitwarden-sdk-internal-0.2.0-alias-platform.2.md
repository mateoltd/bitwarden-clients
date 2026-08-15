# Canonical SDK 0.2.0-alias-platform.2

- Package: `@bitwarden/sdk-internal`
- Source repository: https://github.com/mateoltd/bitwarden-sdk-internal.git
- Public ref: `refs/heads/integration/public-alias-sdk`
- Source commit: `4a08b5fe81c363169d36f582cc13c03b59d212d8`
- Alias reference schema: `1`
- Workflow run: `31660227603`
- Workflow URL: https://github.com/mateoltd/bitwarden-sdk-internal/actions/runs/31660227603
- Artifact: `alias-sdk-release-candidate-4a08b5fe81c363169d36f582cc13c03b59d212d8` (`9166399466`)
- Artifact ZIP SHA-256: `8e266b21d4fe7d7672889c1ad75767186f30085fd811fbc170c23bff89e9b877`
- SHA-256: `bc9106926f418fbc139e4bb29031e2d27cf59e503abcd08455cc29ea8f79af47`
- npm integrity: `sha512-ulXQ5dSHjxdhUDNsKR66pStPbyoq5klSznU/hKs4kSdhcGr87wAiaVsB3LYyrR+Acc4hPB2Wd5GB9wOqm/kMTw==`
- Published handoff manifest: `vendor/bitwarden-sdk-internal-0.2.0-alias-platform.2.handoff.json`
- Handoff manifest SHA-256: `69e35520d0b5cfa1e321b4bcbcbd6a2d0283aa430c6cdb3ae46540b9a538a184`
- Published checksum index: `vendor/bitwarden-sdk-internal-0.2.0-alias-platform.2.candidate.SHA256SUMS`
- Checksum index SHA-256: `f1198ebb3d5b9e47204aca6d7c0d2a934e9dae5c6135f5df3e4be4814b763709`
- Raw SDK producer environment: `vendor/bitwarden-sdk-internal-0.2.0-alias-platform.2.build-environment.txt`
- Raw SDK producer environment SHA-256: `3e2855d9d38968721caed7d2cba92e89b64cb4fa81f3ec43002a01021f99df0e`
- Client SDK toolchain handoff: `vendor/bitwarden-sdk-internal-0.2.0-alias-platform.2.toolchain-handoff.json`
- Toolchain handoff SHA-256: `b7aaf9cd8ed2e5135cfb12662affc13f6cf5540a4fbaf1af96f810bc3d1b16a3`

## SDK producer toolchain

- Runner image: `ubuntu24-20260720.247.2`
- Node: `24.17.0`
- npm: `11.13.0`
- Rust: `1.96.0`
- wasm-opt: `131`

These values describe the separately produced SDK artifact. They are validated independently from
the alias client release toolchain, whose npm version is `11.18.0`. The toolchain handoff names
values that the producer's immutable text evidence emitted without field labels, and separately
records the client consumer toolchain. It does not alter the producer evidence or imply that the
npm versions match.

This archive is an explicit, checksum-enforced build input for the public OSS clients.
