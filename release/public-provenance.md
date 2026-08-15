# Public alias release provenance

The release manifest records the repositories that actually produced this client state and its
pinned SDK artifact:

- Client source: [`mateoltd/bitwarden-clients`](https://github.com/mateoltd/bitwarden-clients),
  with the exact release branch and commit verified at release time.
- SDK source: [`mateoltd/bitwarden-sdk-internal`](https://github.com/mateoltd/bitwarden-sdk-internal),
  ref `refs/heads/integration/public-alias-sdk`, commit
  `4a08b5fe81c363169d36f582cc13c03b59d212d8`.
- Provider operations harness:
  [`mateoltd/simplelogin-owned-provider`](https://github.com/mateoltd/simplelogin-owned-provider),
  commit `e157b6804f7b1b60e149207cebe2d414f6e4a73f`, asserting SimpleLogin upstream commit
  `dbc45fcce4e8e6b4fa615cc729ca95a67bf75266`.

These are canonical public source coordinates, not hidden infrastructure. The headed-provider
workflow exposes repository and exact-ref inputs with these coordinates as defaults, so a
downstream public fork can select its own public harness without changing or obscuring the source
provenance for this release.
