# Measured frontend inventory

This report is generated from tracked source and configuration only. It does not build, execute, or type-check an application.

## Reproduce

```sh
node docs/architecture/frontend-redesign/measure-frontend.mjs --check
```

Use `--write` to regenerate this file. The script requires only Node.js and Git; it does not read `node_modules`.

## Repository point

| Field | Value |
| --- | --- |
| Exact `origin/main` base | `1f881babc15eb7d3a88cad41730ce167d8e49a41` |
| Local `origin/main` | `1f881babc15eb7d3a88cad41730ce167d8e49a41` |
| Local `upstream/main` | `1f881babc15eb7d3a88cad41730ce167d8e49a41` |
| Local ref divergence (`upstream/main` only / `origin/main` only) | 0 / 0 |

> No fetch is performed. Ref values are the local values present when the report is generated.

## Framework and boundary inventory

| Scope | Prod TS/JS | Angular files | Components | Directives | Pipes | Route paths | Injectables | `inject()` | Provider bindings | Service/state files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Web application | 601 | 419 | 262 | 7 | 6 | 160 in 12 files | 69 | 453 | 97 | 82 |
| Browser extension | 448 | 128 | 78 | 2 | 0 | 95 in 1 files | 32 | 140 | 91 | 117 |
| Desktop application | 192 | 65 | 35 | 0 | 0 | 62 in 1 files | 18 | 125 | 72 | 58 |
| Shared libraries | 2740 | 541 | 306 | 72 | 12 | 0 in 0 files | 64 | 442 | 280 | 509 |
| Commercial overlays (read-only) | 477 | 222 | 139 | 0 | 6 | 89 in 15 files | 31 | 170 | 56 | 76 |

| Scope | State definitions | State keys | Injection tokens | RxJS files | Lit files/elements | React files | Specs | Stories |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Web application | 0 | 15 | 1 | 222 | 0 / 0 | 0 | 161 | 53 |
| Browser extension | 0 | 16 | 0 | 142 | 68 / 3 | 0 | 169 | 35 |
| Desktop application | 0 | 14 | 0 | 56 | 0 / 0 | 0 | 50 | 0 |
| Shared libraries | 107 | 163 | 9 | 475 | 0 / 0 | 1 | 678 | 97 |
| Commercial overlays (read-only) | 0 | 7 | 0 | 141 | 0 / 0 | 0 | 106 | 26 |

Decorator counts exclude test and story files. A route path is a `path:` property in a production TypeScript file that imports `@angular/router`; it is a migration-surface proxy, not a claim that every path is reachable in every build configuration. Provider bindings count object-literal `provide:` registrations and therefore omit shorthand class providers.

### Framework-neutral core check

| Project | Prod TS/JS | Angular import files | Service/state files | RxJS files |
| --- | --- | --- | --- | --- |
| `libs/common` | 1013 | 0 | 288 | 177 |
| `libs/state` | 110 | 0 | 8 | 7 |
| `libs/state-internal` | 20 | 0 | 8 | 11 |
| `libs/storage-core` | 12 | 0 | 4 | 3 |
| `libs/messaging` | 9 | 0 | 0 | 3 |
| `libs/logging` | 8 | 0 | 2 | 0 |
| `libs/serialization` | 4 | 0 | 0 | 0 |
| `libs/user-core` | 3 | 0 | 0 | 0 |

These projects are not the whole domain layer, but they establish a substantial existing boundary that can be consumed without an Angular runtime.

### Shared UI projects

| Project | Components | Directives | Pipes | Angular files | Stories | Specs |
| --- | --- | --- | --- | --- | --- | --- |
| `libs/components` | 135 | 47 | 0 | 243 | 81 | 39 |
| `libs/vault` | 63 | 5 | 5 | 94 | 3 | 64 |
| `libs/angular` | 18 | 20 | 5 | 86 | 2 | 27 |
| `libs/auth` | 24 | 0 | 0 | 30 | 3 | 29 |
| `libs/tools/send/send-ui` | 15 | 0 | 1 | 23 | 1 | 10 |
| `libs/importer` | 15 | 0 | 0 | 20 | 0 | 48 |
| `libs/tools/generator/components` | 13 | 0 | 0 | 15 | 0 | 0 |
| `libs/key-management-ui` | 11 | 0 | 0 | 13 | 0 | 10 |
| `libs/pricing` | 3 | 0 | 0 | 3 | 3 | 4 |
| `libs/subscription` | 3 | 0 | 0 | 3 | 3 | 3 |
| `libs/auto-confirm` | 2 | 0 | 0 | 3 | 0 | 2 |
| `libs/tools/export-vault-ui` | 2 | 0 | 0 | 2 | 0 | 0 |
| `libs/dirt/card` | 1 | 0 | 0 | 1 | 1 | 0 |
| `libs/logging-angular` | 1 | 0 | 0 | 2 | 0 | 1 |
| `libs/ui/common` | 0 | 0 | 1 | 3 | 0 | 1 |

The separate browser autofill component package contributes **67 production Lit files**, **1 registered custom element**, and **32 stories**.

### Application imports into workspace packages

#### Web application

| Workspace package | Importing files | Import statements |
| --- | --- | --- |
| `@bitwarden/common` | 388 | 2117 |
| `@bitwarden/components` | 261 | 263 |
| `@bitwarden/angular` | 82 | 105 |
| `@bitwarden/vault` | 71 | 71 |
| `@bitwarden/ui-common` | 64 | 64 |
| `@bitwarden/web-vault` | 56 | 111 |
| `@bitwarden/admin-console/common` | 48 | 48 |
| `@bitwarden/key-management` | 42 | 42 |
| `@bitwarden/sdk-internal` | 22 | 24 |
| `@bitwarden/assets` | 21 | 21 |
| `@bitwarden/auth/angular` | 21 | 21 |
| `@bitwarden/logging` | 17 | 17 |
| `@bitwarden/pricing` | 15 | 15 |
| `@bitwarden/auth/common` | 14 | 14 |
| `@bitwarden/user-core` | 8 | 8 |

#### Browser extension

| Workspace package | Importing files | Import statements |
| --- | --- | --- |
| `@bitwarden/common` | 261 | 1221 |
| `@bitwarden/components` | 87 | 87 |
| `@bitwarden/angular` | 74 | 109 |
| `@bitwarden/vault` | 34 | 34 |
| `@bitwarden/ui-common` | 17 | 17 |
| `@bitwarden/auth/common` | 15 | 15 |
| `@bitwarden/browser` | 13 | 20 |
| `@bitwarden/assets` | 13 | 13 |
| `@bitwarden/key-management` | 12 | 12 |
| `@bitwarden/auth/angular` | 12 | 12 |
| `@bitwarden/admin-console/common` | 9 | 9 |
| `@bitwarden/sdk-internal` | 6 | 7 |
| `@bitwarden/logging` | 6 | 6 |
| `@bitwarden/state` | 6 | 6 |
| `@bitwarden/user-core` | 5 | 5 |

#### Desktop application

| Workspace package | Importing files | Import statements |
| --- | --- | --- |
| `@bitwarden/common` | 112 | 593 |
| `@bitwarden/components` | 48 | 48 |
| `@bitwarden/ui-common` | 26 | 26 |
| `@bitwarden/angular` | 22 | 39 |
| `@bitwarden/vault` | 22 | 22 |
| `@bitwarden/key-management` | 20 | 20 |
| `@bitwarden/desktop-napi` | 20 | 20 |
| `@bitwarden/sdk-internal` | 11 | 12 |
| `@bitwarden/assets` | 7 | 7 |
| `@bitwarden/auth/common` | 7 | 7 |
| `@bitwarden/auth/angular` | 6 | 6 |
| `@bitwarden/logging` | 6 | 6 |
| `@bitwarden/key-management-ui` | 5 | 5 |
| `@bitwarden/generator-components` | 4 | 4 |
| `@bitwarden/send-ui` | 3 | 3 |

## Platform shells

| Sub-surface | Prod TS/JS | Angular files | Components | Lit files | Electron files | WebExtension API files |
| --- | --- | --- | --- | --- | --- | --- |
| Browser popup/sidebar Angular UI | 141 | 124 | 78 | 0 | 0 | 10 |
| Browser background contexts | 31 | 0 | 0 | 0 | 0 | 22 |
| Browser autofill content and embedded UI | 113 | 0 | 0 | 68 | 0 | 11 |
| Desktop Electron main | 33 | 0 | 0 | 0 | 28 | 0 |
| Desktop preload bridge | 7 | 0 | 0 | 0 | 7 | 0 |

Desktop IPC is a material non-UI boundary: production source contains **53 main-process registrations** and **75 renderer/preload sends or listeners**. The BrowserWindow configuration sets `nodeIntegration: false` and `contextIsolation: true`; the preload exposes one `ipc` object with five owned namespaces.

### Extension manifest constraints

| Manifest | Content-script blocks/files | Background | Permissions | Web-accessible resources | Sandbox pages | Extension-page CSP |
| --- | --- | --- | --- | --- | --- | --- |
| MV2 | 2 / 2 | `background.html, persistent=true` | 14 | 8 | 2 | `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` |
| MV3 | 2 / 2 | `background.js` | 16 | 8 | 2 | `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` |

The two manifest templates are transformed per Chrome, Edge, Firefox, Opera, and Safari. Webpack also emits popup, content, notification, overlay, background, and offscreen-document contexts; these are separate execution/security contexts even when they share TypeScript packages.

## Localization and theming

| Surface | Locale bundles | English keys |
| --- | --- | --- |
| Web | 66 | 4231 |
| Browser | 63 | 2044 |
| Desktop | 66 | 1734 |

The three English catalogs contain **5077 distinct keys**; **1326 keys** exist in all three. Key overlap supports a shared translation contract, but the bundles are not interchangeable.

| Theme measure | Count |
| --- | --- |
| Unique `--color-*` tokens in `libs/components/src/tw-theme.css` | 282 |
| Production TS/HTML files containing prefixed Tailwind utilities | 695 |
| Prefixed Tailwind utility references | 9563 |
| `theme_light` / `theme_dark` references | 33 |

The shared Tailwind base scans shared feature libraries, while app configs add web, browser, desktop, and commercial overlay paths. Theme selection is persisted through the shared state provider and applied as `theme_light` or `theme_dark`; the web app also applies a pre-bootstrap theme to avoid a flash.

## Storybook and test seams

| Scope | Specs/tests | Stories |
| --- | --- | --- |
| Web application | 161 | 53 |
| Browser extension | 169 | 35 |
| Desktop application | 50 | 0 |
| Shared libraries | 678 | 97 |
| Commercial overlays (read-only) | 106 | 26 |

The root Storybook uses the Angular renderer and Compodoc, theme, accessibility, and feature-flag decorators. Browser autofill has a second Storybook using the Web Components/Vite renderer and is composed into the root Storybook. Counts show file-level seams only; they do not imply equivalent behavioral coverage.

## Upstream-sync surface

The local `origin/main` and `upstream/main` refs are aligned at the recorded base. In the latest **250 upstream commits** available locally:

| Scope | Commits touching scope | Unique files touched | File touches |
| --- | --- | --- | --- |
| Web application | 76 | 317 | 773 |
| Browser extension | 54 | 221 | 491 |
| Desktop application | 47 | 134 | 401 |
| Shared libraries | 107 | 498 | 638 |

This bounded churn sample is a maintenance-pressure indicator, not a forecast. A replacement that rewrites high-churn files increases recurring merge and review cost; extraction behind existing boundaries can keep upstream reconciliation file-local.

## Counting limitations

- All measurements are lexical and operate on tracked files. They do not resolve runtime feature flags, lazy imports, inheritance, re-exports, or commercial build selection.
- Production decorator, route, and service counts exclude `*.spec.*`, `*.test.*`, story files, and directories named `spec`, `test`, or `tests`.
- The browser sub-surface path groups intentionally overlap where code serves more than one extension context.
- Commercial overlays are read for counts only and are not modified by this work.
