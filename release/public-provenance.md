# Public alias release provenance

The release manifest records the repositories that actually produced this client state and its
pinned SDK artifact:

- Client source: [`mateoltd/bitwarden-clients`](https://github.com/mateoltd/bitwarden-clients),
  branch `refs/heads/integration/alias-clients-launch-20260926`, based on the frozen Bitwarden
  upstream `main` at `45eb0013dc413dab78932c418d209d89371febf6`. Existing merge topology
  and downstream history are preserved; the final client source is verified at release time.
- SDK source: [`mateoltd/bitwarden-sdk-internal`](https://github.com/mateoltd/bitwarden-sdk-internal),
  ref `refs/heads/integration/alias-sdk-launch-20260926`, commit
  `5562c7eafe6826594e4096d6d0d77ac9668b8bfe`, workflow run `36289197668`, artifact
  `alias-sdk-release-candidate-5562c7eafe6826594e4096d6d0d77ac9668b8bfe`. The complete
  candidate checksum index, schema-3 handoff manifest, CycloneDX SBOM, Sigstore bundle, and
  GitHub-hosted SLSA attestations are pinned in the release manifest and vendor evidence.
- Provider operations harness:
  [`mateoltd/simplelogin-owned-provider`](https://github.com/mateoltd/simplelogin-owned-provider),
  commit `e157b6804f7b1b60e149207cebe2d414f6e4a73f`, asserting SimpleLogin upstream commit
  `dbc45fcce4e8e6b4fa615cc729ca95a67bf75266`.
- Official test server: [`bitwarden/server`](https://github.com/bitwarden/server), commit
  `6fcd3b71f5f2eb0881dd4a3b587fa8afe5957da1`, delivered as Bitwarden Lite `2026.9.0` at OCI
  manifest digest `sha256:616624bf9a2e1bae68a6a7735732339db41b831e38593846f0c2b4983af34bb9`.

These are canonical public source coordinates, not hidden infrastructure. The headed-provider
workflow exposes repository and exact-ref inputs with these coordinates as defaults, so a
downstream public fork can select its own public harness without changing or obscuring the source
provenance for this release.
