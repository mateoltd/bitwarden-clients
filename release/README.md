# Alias client candidate releases

This directory defines the public, open-source candidate lane for the alias-enabled clients in
this repository. It builds the current alias schema without changing product behavior or UI. No
store, registry, release, signing, or notarization operation is part of the lane.

## Trust inputs

`alias-client-release.json` is the single release manifest. It pins the starting client commit,
toolchains, canonical SDK artifact and source commit, checksum-pinned extension test Chromium, real
provider test deployment, official Bitwarden test server, supported targets, and explicit
handoffs. `npm run
release:verify` fails if the checked-out branch does not descend from the pinned base, the SDK
archive or lock entry differs, a target is duplicated, a lock is missing, or commercial source is
present in an OSS clean room.

The build scripts consume the canonical SDK tarball only through the root lockfile. The archive
SHA-256, npm integrity, embedded package version, embedded source commit, and the published SDK
handoff manifest must all agree before dependency installation or compilation.

## Build and verify

Install exactly Node `24.17.0` and npm `11.18.0`, then run:

```sh
npm run release:verify
scripts/release/export-oss-source.sh /tmp/bitwarden-alias-oss
cd /tmp/bitwarden-alias-oss
npm ci
npm ci --prefix release/tooling
npm run release:build -- browser-chrome --output release-out
npm run release:smoke -- browser-chrome release-out/bitwarden-browser-chrome-2026.7.0.zip
```

Use a target ID from the manifest. Candidate archives have normalized ordering, timestamps,
ownership, and permissions. The hosted workflow builds each target on its declared OS and
architecture, installs or extracts it, launches it where the host can execute that architecture,
and uploads it without publishing it.

Chromium extension launch checks use the exact Chrome for Testing archive declared in the manifest.
The runtime installer verifies Playwright's revision and browser version, the archive byte count,
SHA-256, member paths, executable, and reported version before any extension test starts.

The qualification workflow builds `scripts/release/pinned-toolchain.Dockerfile` from the exact
Node, Python, and Rust image digests in the manifest. A fresh OSS export is mounted into that
container for `npm ci`; `release:verify-sdk-install` then requires both SDK dependency names to be
physical installs and loads the pinned WASM package from browser, web, desktop, CLI, and common
library package contexts.

The positive headed lane uses official Bitwarden Lite `2026.7.2` at the exact image digest and
source commit in the manifest. Its own Admin service creates the SQLite schema before a local-only
account is bootstrapped. Browser, web, desktop/Electron, encrypted sync, restart/unlock,
send/reply, and 10,000-record cross-device suites all run against that server.

Vaultwarden `1.37.1` remains a negative compatibility check only. The browser emits a value-free
request shape proving that the top-level `data` field is a non-empty opaque string, contains none
of the known token, address, login, or marker plaintext, and sends no legacy `login` or `fields`
payload. The check requires Vaultwarden to return HTTP 400 and log `Data missing`. The v1 wire
schema is not altered and no alternate carrier or compatibility shim is provided.

The metadata job emits adjacent CycloneDX SBOMs, SLSA-format provenance statements,
source-commit manifests, per-file SHA-256 files, and a combined `SHA256SUMS`. Candidates are
unsigned. Release signing, notarization, and store submission require the credentials listed in
the manifest and remain operator handoffs.

## One-command SDK repin

Download and extract the complete SDK candidate produced by the canonical SDK release workflow,
then run one command:

```sh
npm run release:sdk:repin -- --candidate /absolute/path/extracted-candidate --source-ref refs/heads/BUILD_BRANCH --source-commit BUILD_COMMIT --workflow-run RUN_ID --artifact-id ARTIFACT_ID --artifact-name ARTIFACT_NAME --artifact-zip-sha256 ZIP_SHA256
```

The command verifies every file against the candidate `SHA256SUMS`, requires a schema-3
`handoff-manifest.json`, verifies the signed SBOM and Sigstore statement coordinates, selects its
single `typescriptWasm` package, and checks the published source ref and commit, package version,
archive size and digest, `VERSION`, `PACKAGE_VERSION`, and build environment. It then copies the
archive, SBOM, Sigstore bundle, and provenance into `vendor/`, updates the manifest and root
dependency, refreshes the lockfile with the pinned npm version, writes human-readable vendor
metadata, removes the superseded SDK pin, and re-runs every release and public-scope verifier. It
does not fetch a branch or infer compatibility from a branch name.

The repin changes only the public canonical SDK input. The separately licensed commercial SDK is
outside this release contract and is absent from the checked-in public default dependency graph.
Its exact package metadata and opt-in install command live in `commercial-sdk-overlay.json`; see
`commercial-sdk-boundary.md` for the license and source-usage audit.

Validate the candidate against the committed pin without changing files:

```sh
npm run release:sdk:repin -- --candidate /absolute/path/extracted-candidate --source-ref refs/heads/BUILD_BRANCH --source-commit BUILD_COMMIT --workflow-run RUN_ID --artifact-id ARTIFACT_ID --artifact-name ARTIFACT_NAME --artifact-zip-sha256 ZIP_SHA256 --check
```

## Clean-room rebuild

The clean-room workflow exports only tracked OSS source, excludes `bitwarden_license`, verifies
that the already-OSS package manifest and lock need no rewrite, and builds the requested target
twice from fresh installs. Both passes use the same guarded canonical
workspace path, with the first source removed before the second export, so path-sensitive native
toolchains receive identical inputs. It compares the logical archive content and then the final
candidate SHA-256 values. Run the same path locally with:

```sh
scripts/release/clean-room-rebuild.sh browser-chrome
```

The OSS Linux ARM64 CLI packages JavaScript source instead of V8 cached bytecode because V8's
cached-data blobs are process-dependent on that target. The input remains the verified OSS clean
room, and both its logical content digest and normalized archive checksum remain enforced.

## Upstream maintenance

The drift workflow fetches Bitwarden client main and the canonical public SDK ref into temporary
checkout paths. It reports commit distance, changed release and alias surfaces, overlap risk,
missing refs, and exact review or repin commands. It uploads a Markdown report and never merges,
rebases, force-pushes, or changes configured remotes.

There is no native iOS or Android source in this repository. Mobile release artifacts therefore
require a separate source handoff and are not represented by placeholder jobs.
