# Public alias release provenance

The release manifest records the repositories that actually produced this client state and its
pinned SDK artifact:

- Client source: [`mateoltd/bitwarden-clients`](https://github.com/mateoltd/bitwarden-clients),
  branch `refs/heads/integration/provider-neutral-alias-clients`, based exactly on
  `refs/remotes/origin/fix/public-alias-review-findings` at
  `dd217a8ce662b40dbd0b2465a97edb806a60c924`; the final source commit is verified at release
  time.
- SDK source: [`mateoltd/bitwarden-sdk-internal`](https://github.com/mateoltd/bitwarden-sdk-internal),
  ref `refs/heads/refactor/provider-neutral-alias-v1`, commit
  `99c33ed26e51421224a4daecdf838057f1d66e75`, workflow run `31928076589`, artifact
  `alias-sdk-release-candidate-99c33ed26e51421224a4daecdf838057f1d66e75`. The complete
  candidate checksum index, schema-3 handoff manifest, CycloneDX SBOM, Sigstore bundle, and
  GitHub-hosted SLSA attestations are pinned in the release manifest and vendor evidence.
- Provider operations harness:
  [`mateoltd/simplelogin-owned-provider`](https://github.com/mateoltd/simplelogin-owned-provider),
  commit `e157b6804f7b1b60e149207cebe2d414f6e4a73f`, asserting SimpleLogin upstream commit
  `dbc45fcce4e8e6b4fa615cc729ca95a67bf75266`.
- Official test server: [`bitwarden/server`](https://github.com/bitwarden/server), commit
  `ffc280d2891270f7248812263aa1140e49f9c776`, delivered as Bitwarden Lite `2026.7.2` at OCI
  manifest digest `sha256:ca1007fb3a8e973692ca1b92b87e52d2101976ef9bdf76d8639682485a5866dc`.

These are canonical public source coordinates, not hidden infrastructure. The headed-provider
workflow exposes repository and exact-ref inputs with these coordinates as defaults, so a
downstream public fork can select its own public harness without changing or obscuring the source
provenance for this release.
