# UI redesign baseline tests

This suite protects the current behavior and rendered surfaces while allowing a later redesign to
change implementation incrementally. It uses the repository's Angular and Lit Storybooks,
Playwright, and `axe-playwright`.

## Install

Use the Node version required by the root `package.json`, then install the locked dependencies and
Playwright's Chromium build:

```sh
npm ci
npx playwright install chromium
```

## Run

```sh
# Headless screenshots, semantic assertions, keyboard checks, and axe
npm run test:ui-redesign

# The same suite in a visible browser
npm run test:ui-redesign:headed
```

The Playwright config starts the Angular Storybook on port 6006 and the autofill Lit Storybook on
port 6007. Existing servers on those ports are reused outside CI.

Failure traces are written to `test-results`; the CI HTML report is written to `playwright-report`.
Both directories are ignored.

## Renderer pilot

The non-production renderer comparison has a separate deterministic harness:

```sh
npm run typecheck:ui-redesign-pilot
npm run test:ui-redesign-pilot:unit
npm run test:ui-redesign-pilot
npm run check:ui-redesign-pilot-boundaries
npm run measure:ui-redesign-pilot:bundles
npm run measure:ui-redesign-pilot:runtime
npm run measure:ui-redesign-pilot:maintenance
```

Run `npm run build:ui-redesign-pilot` and
`node tests/ui-redesign/renderer-pilot/tooling/serve.mjs` to inspect Angular, React, and Lit at
`http://127.0.0.1:6010`. The [evidence report](../../docs/architecture/frontend-redesign/renderer-pilot-evidence.md)
records scope, measurements, exclusions, and go/stop criteria.

## Update screenshot baselines

Only update snapshots after intentionally changing an in-scope rendered surface:

```sh
npm run test:ui-redesign:update
npm run test:ui-redesign:headed
git diff -- tests/ui-redesign/__screenshots__
```

Review every changed image in the headed interface. A snapshot update is not evidence that a change
is correct. Keep the semantic, focus, and axe assertions unless the product requirement itself has
changed and the replacement assertion proves the new behavior.

## Covered fixtures

| Flow                         | Storybook fixture                                                    |
| ---------------------------- | -------------------------------------------------------------------- |
| Authentication               | `auth-login--email-entry`                                            |
| Unlock                       | `auth-unlock--master-password`                                       |
| Vault list                   | `web-vault-items--individual`                                        |
| Vault search and popup shell | `browser-popup-layout--filterable-table-list`                        |
| Narrow vault search          | `browser-popup-layout--filterable-table-list-narrow`                 |
| Narrow extension shell       | `browser-popup-layout--narrow-width`                                 |
| Item edit                    | `vault-cipher-form--edit`                                            |
| Generator                    | `components-inline-menu-password-generator--fill-generated-password` |
| Settings                     | `admin-console-organizations-settings-account--default`              |
| Autofill item actions        | `components-inline-menu-cipher-list--default`                        |
| Autofill save prompt         | `components-inline-menu-prompt--save-login`                          |

The stable data belongs in the Storybook stories so visual inspection, component documentation, the
existing Storybook axe runner, Chromatic, and this suite observe the same fixture.

The renderer pilot uses the unchanged `Component Library/No Items` story as its light/dark visual
baseline. Angular, React, and Lit pilots intentionally have no visual snapshots: they compare
behavior, semantics, tokens, localization, accessibility, cost, and maintenance without proposing a
new visual design.

## Accessibility enforcement

The full axe ruleset is enforced for every baseline story, including the popup vault table at its
default and narrow widths. No popup accessibility rule is disabled or waived.
