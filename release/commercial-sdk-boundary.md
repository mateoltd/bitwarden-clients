# Commercial SDK dependency boundary

The public default install graph is OSS-only. `package.json` and `package-lock.json` do not contain
`@bitwarden/commercial-sdk-internal`; public browser, web, desktop, and CLI builds use the pinned
`@bitwarden/sdk-internal` artifact instead. The package metadata embedded in that checked-in
artifact identifies it as `GPL-3.0-only` and names
[`bitwarden/sdk-internal`](https://github.com/bitwarden/sdk-internal) as its source repository; the
SDK verifier enforces both fields alongside its digest and provenance.

## Package evidence

The npm registry metadata for
[`@bitwarden/commercial-sdk-internal@0.2.0-main.971`](https://www.npmjs.com/package/@bitwarden/commercial-sdk-internal/v/0.2.0-main.971)
identifies its license as `BITWARDEN SOFTWARE DEVELOPMENT KIT LICENSE AGREEMENT`, its package
repository as [`bitwarden/sdk-internal`](https://github.com/bitwarden/sdk-internal), and the exact
registry tarball, SHA-256, and integrity recorded in `release/commercial-sdk-overlay.json`. This is
not an OSS dependency and is not represented as one.

## Actual source usage

The commercial package is referenced only by the separately licensed source under
`bitwarden_license`: its browser, web, and CLI webpack configurations alias the normal SDK import
to `@bitwarden/commercial-sdk-internal`, and `bit-common` supplies the matching type declaration.
The public `apps` and `libs` source has no direct commercial-package import. The release verifier
checks that boundary from the checked-in source instead of filtering commercial components out of
an SBOM after installation.

Commercial builds opt in by running:

```sh
node scripts/release/commercial-sdk-overlay.mjs --install
```

That command reads the exact package, version, license evidence, tarball, and integrity from the
overlay manifest. Commercial CI lanes invoke it explicitly after the OSS default `npm ci`; OSS
lanes never install and then delete the package.
