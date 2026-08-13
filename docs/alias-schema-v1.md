# Email alias wire schema v1

Version 1 is the first public email-alias schema. Browser, web, desktop, CLI, and shared
generator/vault code must emit and accept only version 1 records.

The encrypted login binding is the canonical SDK alias reference stored in the first-class
`login.aliasReference` member. It contains only `version`, `provider`,
`providerInstance`, `connectionId`, `aliasId`, and the last observed `address`. The SDK creates,
parses, serializes, and binds this reference. Client code does not infer a reference from a login
address.

The encrypted connection carrier is the personal secure note named
`bitwarden.alias.connection.v1`. Its payload and its nested synchronization document and events
all use version 1. The carrier may contain the provider credential because the entire item follows
the normal vault encryption path. Journal events never contain credentials.

All parsers reject a missing version, zero, a non-integer or otherwise malformed version, version
2, and any unknown version. Rejection happens before a provider mutation. There is no v2 decoder,
migration, fallback, development-schema compatibility, address inference, lazy `connectionId`
creation, or personal-import path.

Cross-device behavior remains event based. Vector clocks retain concurrent edits, connection
removal and alias deletion remain terminal, reference changes use compare-and-set preconditions,
unknown provider outcomes require reconciliation, and conflicts require an explicit resolution.

Encrypted exports and restored carriers preserve valid v1 data. Plaintext and personal vault
import paths must not manufacture alias references or connection carriers.
