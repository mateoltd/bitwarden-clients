# Alias client candidate releases

This directory defines the public, open-source candidate lane for the alias-enabled clients in
this repository. It builds the current alias schema without changing product behavior or UI. No
store, registry, release, signing, or notarization operation is part of the lane.

## Trust inputs

`alias-client-release.json` is the single release manifest. It pins `origin/main`, the two state-only
client and release inputs, toolchains, canonical SDK artifact and source commit, real provider test
deployment, vault test backend, supported targets, and explicit handoffs. `npm run release:verify`
fails if the linear public history does not begin directly at the pinned base, either development
history is inherited, the SDK archive or lock entry differs, a target is duplicated, a lock is
missing, or commercial source is present in an OSS clean room.

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

The metadata job emits adjacent CycloneDX SBOMs, SLSA-format provenance statements,
source-commit manifests, per-file SHA-256 files, and a combined `SHA256SUMS`. Candidates are
unsigned. Release signing, notarization, and store submission require the credentials listed in
the manifest and remain operator handoffs.

## One-command SDK repin

Download and extract the complete SDK candidate produced by the canonical SDK release workflow,
then run one command:

```sh
npm run release:sdk:repin -- --candidate /absolute/path/extracted-candidate --source-commit BUILD_COMMIT --functional-commit FUNCTIONAL_COMMIT
```

The command verifies every file against the candidate `SHA256SUMS`, requires a schema-2
`handoff-manifest.json`, selects its single `typescriptWasm` package, and checks the published
source commit, package version, archive size and digest, `VERSION`, `PACKAGE_VERSION`, and build
environment. It then copies the archive and provenance into `vendor/`, updates the manifest and
root dependency, refreshes the lockfile with the pinned npm version, writes human-readable vendor
metadata, removes the superseded SDK pin, and re-runs every release and public-scope verifier. It
does not fetch a branch or infer compatibility from a branch name.

The repin changes only the public canonical SDK input. The commercial SDK is outside this release
contract and is removed from clean-room dependency graphs before installation.

Validate the candidate against the committed pin without changing files:

```sh
npm run release:sdk:repin -- --candidate /absolute/path/extracted-candidate --source-commit BUILD_COMMIT --functional-commit FUNCTIONAL_COMMIT --check
```

## Clean-room rebuild

The clean-room workflow exports only tracked OSS source, excludes `bitwarden_license`, removes the
commercial SDK from the exported package manifest and lock before dependency installation, builds
the requested target twice in separate directories, and compares candidate SHA-256 values. Run the
same path locally with:

```sh
scripts/release/clean-room-rebuild.sh browser-chrome
```

## Upstream maintenance

The drift workflow fetches Bitwarden client main, the canonical SDK tracking ref, and the two
cleanup refs into temporary checkout paths. It reports commit distance, changed release and alias
surfaces, overlap risk, missing refs, and exact review or repin commands. It uploads a Markdown
report and never merges, rebases, force-pushes, or changes configured remotes.

There is no native iOS or Android source in this repository. Mobile release artifacts therefore
require a separate source handoff and are not represented by placeholder jobs.
