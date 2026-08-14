# Renderer pilot evidence

## Scope and provenance

This Phase 1/2 pilot starts from `origin/test/ui-redesign-ready` at
`346b7658564b5d631b093e80b155b07564dc85c6`. It does not alter production navigation,
application shells, information architecture, branding, or the rendered production component.
The pilot bundles are non-production test artifacts.

The selected surface is the existing `NoItemsComponent` leaf and its `Component Library/No Items`
Storybook story. It fits the dossier criteria:

| Criterion          | Evidence                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security           | The surface handles no credentials, decrypted secrets, payment, WebAuthn, autofill, clipboard, files, IPC, worker lifecycle, permissions, or platform capabilities.                                                                   |
| Shell dependency   | It is a leaf with one mount/unmount owner and no route, guard, navigation, or application-shell dependency.                                                                                                                           |
| Forms and overlays | It uses neither reactive forms nor Angular CDK overlays.                                                                                                                                                                              |
| Localization       | All pilot text comes from one typed localization snapshot. Deterministic English, Spanish, and Arabic catalogs exercise dynamic locale changes and RTL. The leaf has no placeholders, so placeholder substitution is not applicable.  |
| State              | The controller owns only transient idle, pending, error, canceled, and complete presentation state. The only command capability is `refresh(AbortSignal)`.                                                                            |
| Portability        | Its contract is TypeScript plus DOM `AbortSignal`, with no Angular, React, Lit, Electron, or WebExtension types. The three renderers share the same controller, reducer, fixtures, tokens, localization contract, and behavior tests. |
| Existing evidence  | The production Angular leaf already has a Storybook story. The redesign baseline now snapshots that unchanged story in light and dark themes.                                                                                         |

The deterministic refresh command is fixture-only and intentionally capability-limited. A future
production slice would inject an existing application service behind `PilotCommandPort`; no pilot
renderer may acquire crypto, storage, sync, account, permission, or platform services directly.

## Shared boundary and behavior

`libs/components/src/semantic-tokens.css` is the framework-neutral CSS entry point.
`tw-theme.css` imports it and retains only framework/reset/utility rules. The boundary checker
compares the extracted declaration block byte-for-byte with the exact base, so token values have one
source of truth and no production token changed.

The common behavior specification is:

1. Render one labeled section with an `h1`, description, polite status, alert region, and Refresh
   button.
2. Activate Refresh with the keyboard; the first fixture outcome exposes a localized error and
   restores focus to Refresh.
3. Retry; while pending, set `aria-busy`, disable Refresh, expose Cancel, and move focus to Cancel.
4. Cancel with the keyboard; announce cancellation and restore focus to Refresh.
5. Retry; announce completion.
6. Change locale dynamically to Spanish and Arabic, including `lang`, RTL `dir`, labels, status, and
   error text.
7. Preserve the same semantic DOM fingerprint and the same nine computed semantic token values in
   light and dark themes.

Angular uses a standalone OnPush, zoneless component; React uses a named functional component and
`useSyncExternalStore`; Lit uses a named custom element. Every adapter has an explicit teardown.
The shared reducer and selectors are pure and total. The injected controller is the only lifecycle
class because it coordinates cancellation, subscriptions, and stale command completion.

## Comparative measurements

Measurements were taken on 2026-08-14 with Node `v24.19.0` and Playwright Chromium
`147.0.7727.15`. Sizes are production-mode isolated harness assets. The common 26,371-byte CSS and
352,240-byte Inter font are included in total transfer rows so the totals are reproducible; JS rows
make renderer cost visible.

| Renderer |    JS raw |   JS gzip | JS Brotli | Total raw | Total gzip | Total Brotli |
| -------- | --------: | --------: | --------: | --------: | ---------: | -----------: |
| Angular  | 446,323 B | 142,193 B | 117,779 B | 824,934 B |  498,921 B |    473,871 B |
| React    | 148,502 B |  47,836 B |  41,458 B | 527,113 B |  404,564 B |    397,550 B |
| Lit      |  24,845 B |   8,585 B |   7,646 B | 403,456 B |  365,313 B |    363,738 B |

Startup is navigation start to the renderer's `renderer-pilot-mounted` performance mark. Each cell
is 15 fresh-browser-context cold runs and 15 same-page reload warm runs with UTC, `en-US`, and
reduced motion. These are deterministic viewport profiles, not measurements embedded in real
application shells.

| Renderer | Profile and viewport         | Cold median / p95 | Warm median / p95 |
| -------- | ---------------------------- | ----------------: | ----------------: |
| Angular  | Web, 1440 x 900              |    20.2 / 25.4 ms |      6.6 / 7.7 ms |
| Angular  | Browser popup, 390 x 600     |    20.7 / 23.5 ms |      7.1 / 8.0 ms |
| Angular  | Desktop renderer, 1280 x 800 |    21.3 / 23.2 ms |      7.4 / 8.3 ms |
| React    | Web, 1440 x 900              |    11.6 / 14.6 ms |      5.3 / 6.1 ms |
| React    | Browser popup, 390 x 600     |    10.1 / 11.4 ms |      4.8 / 9.8 ms |
| React    | Desktop renderer, 1280 x 800 |    10.7 / 17.3 ms |      5.1 / 5.5 ms |
| Lit      | Web, 1440 x 900              |      8.2 / 9.3 ms |      4.2 / 5.0 ms |
| Lit      | Browser popup, 390 x 600     |     8.2 / 10.9 ms |      4.3 / 4.8 ms |
| Lit      | Desktop renderer, 1280 x 800 |      7.6 / 8.3 ms |      3.9 / 4.3 ms |

Maintenance surface is measured as nonblank lines, not estimated developer time:

| Surface                                                                  | Files | Nonblank lines |
| ------------------------------------------------------------------------ | ----: | -------------: |
| Shared contract, controller, reducer, localization, fixtures, and tokens |     7 |            345 |
| Angular adapter                                                          |     3 |            140 |
| React adapter                                                            |     3 |             84 |
| Lit adapter                                                              |     3 |            124 |
| Unit and cross-renderer tests                                            |     2 |            191 |
| Harness, Storybook hosts, build, boundary, and measurement tooling       |     9 |            704 |

In the latest 250 locally available `upstream/main` commits, 15 commits touched the selected leaf's
five production files. The comparison duplicates one leaf across three non-production adapters and
duplicates zero production components. No reliable human-time telemetry exists for this change, so
LOC is reported only as a review/maintenance proxy and not converted to hours.

## Verification and build exclusion

The cross-renderer Playwright suite runs the full axe ruleset with no excluded rules or waivers. It
also checks DOM semantics, keyboard activation, focus restoration, cancellation/error/success,
dynamic locale and RTL, 320-pixel reflow, 200% zoom, forced colors, both themes, nine computed-token
values, strict CSP headers, and all three Storybook stories.

| Check                                                               | Result                                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Shared controller/reducer Jest tests                                | 3 passed                                                                                     |
| Cross-renderer Playwright suite                                     | 8 passed                                                                                     |
| Unchanged redesign baseline                                         | 18 passed; all 16 prior snapshots unchanged; two new current-design No Items snapshots added |
| Pilot strict TypeScript                                             | Passed                                                                                       |
| Repository strict TypeScript                                        | Passed; 3,993 strict files                                                                   |
| Focused ESLint and Prettier                                         | Passed                                                                                       |
| Angular Storybook static build                                      | Passed and validated 1,024 stories                                                           |
| Autofill Storybook static build                                     | Passed and validated 58 stories                                                              |
| Web OSS self-host production build                                  | Passed                                                                                       |
| Chrome MV3 OSS production build                                     | Passed                                                                                       |
| Desktop main/preload/renderer production build                      | Passed                                                                                       |
| Source, token, CSP, dependency, and emitted-artifact boundary check | Passed                                                                                       |

React, ReactDOM, and their types are exact-version development dependencies. Production source has
no imports from React or the pilot. The web, browser, and desktop output directories were scanned for
pilot identifiers and React runtime signatures after successful production builds; the scan found
zero. Therefore the pilot contributes zero production modules and zero production bytes to all three
artifacts.

The standalone harness serves only same-origin scripts, styles, and fonts under
`default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'none';
object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. Emitted bundles are also rejected if
they contain `eval`, `new Function`, or remote dynamic imports.

## Debt kept separate

The repository-wide lint command remains red on pre-existing restricted state imports and component
markup warnings. After fixing every pilot diagnostic, focused lint passes. Dependency ownership now
covers the newly explicit `@types/react-dom`; the ownership command still fails solely because
`@playwright/test` was already unowned at the exact base. Storybook and production builds retain
their existing missing-catalog-pattern, unused-compilation, Sass-deprecation, and asset-budget
warnings. This pilot adds no suppression, axe waiver, warning allowlist, or debt cleanup.

## Reversible go/stop criteria

This evidence completes a non-shipping comparison, not a framework choice.

- **Keep the boundary:** retain the semantic-token entry point and typed command/view-model seam if
  owners agree that the separation is useful independently of renderer choice.
- **Stop safely:** delete `tests/ui-redesign/renderer-pilot`, its Storybook catalog entry and scripts,
  and the four React-only development dependencies. Production behavior and artifacts remain
  unchanged; `semantic-tokens.css` can remain as useful framework-neutral infrastructure.
- **Request another experiment:** repeat only if the owning team needs a different targeted leaf or
  actual shell-embedded measurements. Do not extrapolate these isolated leaf numbers to web,
  extension, content UI, or desktop architecture.
- **Go to a production slice only with separate authorization:** require an agreed shell-specific
  bundle/startup budget, a compile-time or feature-flag rollback to Angular, real service injection,
  equivalent security/accessibility/localization tests, and at least one upstream synchronization
  cycle. A positive result would authorize only that slice.

No result here selects Angular, React, Lit, a mixed strategy, or a full replacement.
