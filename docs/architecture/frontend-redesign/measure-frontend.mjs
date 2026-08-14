#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const reportPath = resolve(scriptDirectory, "measured-inventory.md");
const baselineCommit = "5f640f3bbe94cdc47dbebf81f0c32548080b76da";

function git(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function trackedFiles() {
  return git(["ls-files", "-z"]).split("\0").filter(Boolean);
}

function read(relativePath) {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function countMatches(source, expression) {
  return source.match(expression)?.length ?? 0;
}

function stripComments(source) {
  let result = "";
  let state = "code";
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (character === "\n") {
        state = "code";
        result += character;
      } else {
        result += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state !== "code") {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (
        (state === "single-quote" && character === "'") ||
        (state === "double-quote" && character === '"') ||
        (state === "template" && character === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (character === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block-comment";
    } else {
      result += character;
      if (character === "'") {
        state = "single-quote";
      } else if (character === '"') {
        state = "double-quote";
      } else if (character === "`") {
        state = "template";
      }
    }
  }

  return result;
}

const allFiles = trackedFiles();
const sourceCache = new Map();

function sourceFor(file) {
  if (!sourceCache.has(file)) {
    sourceCache.set(file, read(file));
  }
  return sourceCache.get(file);
}

function isTypeScript(file) {
  return /\.[cm]?[jt]sx?$/.test(file);
}

function isStory(file) {
  return (
    /\.(?:stories|story|lit-stories)\.[cm]?[jt]sx?$/.test(file) ||
    /(?:^|\/)lit-stories\//.test(file)
  );
}

function isTest(file) {
  return /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file) || /(?:^|\/)(?:spec|test|tests)\//.test(file);
}

function isProductionTypeScript(file) {
  return isTypeScript(file) && !isStory(file) && !isTest(file);
}

const scopes = [
  { name: "Web application", prefix: "apps/web/src/" },
  { name: "Browser extension", prefix: "apps/browser/src/" },
  { name: "Desktop application", prefix: "apps/desktop/src/" },
  { name: "Shared libraries", prefix: "libs/" },
  { name: "Commercial overlays (read-only)", prefix: "bitwarden_license/" },
];

const scopeFiles = new Map(
  scopes.map((scope) => [scope.name, allFiles.filter((file) => file.startsWith(scope.prefix))]),
);

function measure(files) {
  const productionTs = files.filter(isProductionTypeScript);
  const sources = productionTs.map((file) => ({
    file,
    source: sourceFor(file),
    code: stripComments(sourceFor(file)),
  }));
  const joined = sources.map(({ code }) => code).join("\n");
  const angularRouterSources = sources.filter(({ source }) =>
    /from\s+["']@angular\/router["']/.test(source),
  );
  const angularFiles = sources.filter(({ source }) => /["']@angular\//.test(source));
  const litFiles = sources.filter(({ source }) =>
    /from\s+["'](?:lit|lit\/|@lit-labs\/)/.test(source),
  );
  const reactFiles = sources.filter(({ source }) =>
    /(?:from\s+["']react(?:\/[^"']*)?["']|require\(["']react)/.test(source),
  );
  const rxjsFiles = sources.filter(({ source }) => /["']rxjs(?:\/[^"']*)?["']/.test(source));
  const electronFiles = sources.filter(({ source }) => /from\s+["']electron["']/.test(source));
  const webExtensionApiFiles = sources.filter(({ code }) =>
    /\b(?:chrome|browser)\.(?:runtime|tabs|storage|scripting|webNavigation|webRequest)\b/.test(
      code,
    ),
  );

  return {
    trackedFiles: files.length,
    productionTs: productionTs.length,
    html: files.filter((file) => file.endsWith(".html")).length,
    styles: files.filter((file) => /\.(?:css|scss)$/.test(file)).length,
    components: countMatches(joined, /@Component\s*\(/g),
    directives: countMatches(joined, /@Directive\s*\(/g),
    pipes: countMatches(joined, /@Pipe\s*\(/g),
    injectables: countMatches(joined, /@Injectable\s*\(/g),
    injectCalls: countMatches(joined, /\binject\s*\(/g),
    injectionTokens: countMatches(joined, /\bnew\s+InjectionToken(?:<[^;\n]+>)?\s*\(/g),
    providerBindings: countMatches(joined, /\bprovide\s*:/g),
    serviceBoundaryFiles: productionTs.filter((file) =>
      /(?:^|\/)[^/]+\.(?:service|provider|state|repository|facade)(?:\.[^/]+)?\.ts$/.test(file),
    ).length,
    stateDefinitions: countMatches(joined, /\bnew\s+StateDefinition\s*\(/g),
    stateKeys:
      countMatches(joined, /\bnew\s+(?:User)?KeyDefinition(?:<[^;\n]+>)?\s*\(/g) +
      countMatches(joined, /\b(?:User)?KeyDefinition\.(?:array|record)\s*</g),
    routeFiles: angularRouterSources.filter(({ code }) => /\bpath\s*:/.test(code)).length,
    routePaths: angularRouterSources.reduce(
      (total, { code }) => total + countMatches(code, /\bpath\s*:/g),
      0,
    ),
    routerRegistrations: angularRouterSources.reduce(
      (total, { code }) => total + countMatches(code, /RouterModule\.(?:forRoot|forChild)\s*\(/g),
      0,
    ),
    angularFiles: angularFiles.length,
    rxjsFiles: rxjsFiles.length,
    litFiles: litFiles.length,
    litCustomElements: countMatches(joined, /\bcustomElements\.define\s*\(/g),
    reactFiles: reactFiles.length,
    electronFiles: electronFiles.length,
    webExtensionApiFiles: webExtensionApiFiles.length,
    specs: files.filter((file) => /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file)).length,
    stories: files.filter(isStory).length,
  };
}

const measurements = new Map(
  scopes.map((scope) => [scope.name, measure(scopeFiles.get(scope.name))]),
);

function markdownTable(headers, rows) {
  const normalizedRows = rows.map((row) => row.map(String));
  const widths = headers.map((header, index) =>
    Math.max(3, header.length, ...normalizedRows.map((row) => row[index].length)),
  );
  const formatRow = (row) =>
    `| ${row.map((value, index) => value.padEnd(widths[index])).join(" | ")} |`;
  const divider = widths.map((width) => "-".repeat(width));
  return [formatRow(headers), formatRow(divider), ...normalizedRows.map(formatRow)].join("\n");
}

function projectRoots() {
  return allFiles
    .filter((file) => file.startsWith("libs/") && file.endsWith("/project.json"))
    .map((file) => dirname(file))
    .sort((left, right) => right.length - left.length);
}

function containingProject(file, roots) {
  return roots.find((root) => file === root || file.startsWith(`${root}/`));
}

function sharedUiProjects() {
  const roots = projectRoots();
  const grouped = new Map();
  for (const file of scopeFiles.get("Shared libraries")) {
    const root = containingProject(file, roots);
    if (!root) {
      continue;
    }
    if (!grouped.has(root)) {
      grouped.set(root, []);
    }
    grouped.get(root).push(file);
  }

  return [...grouped.entries()]
    .map(([root, files]) => ({ root, ...measure(files) }))
    .filter(
      (item) => item.components > 0 || item.directives > 0 || item.pipes > 0 || item.stories > 0,
    )
    .sort(
      (left, right) =>
        right.components +
          right.directives +
          right.pipes -
          (left.components + left.directives + left.pipes) || left.root.localeCompare(right.root),
    );
}

function importAlias(specifier) {
  if (!specifier.startsWith("@bitwarden/")) {
    return null;
  }

  const parts = specifier.split("/");
  const packageName = parts.slice(0, 2).join("/");
  if (
    ["@bitwarden/auth", "@bitwarden/auto-confirm", "@bitwarden/admin-console"].includes(
      packageName,
    ) &&
    ["angular", "common"].includes(parts[2])
  ) {
    return parts.slice(0, 3).join("/");
  }

  return packageName;
}

function workspaceImports(files) {
  const imports = new Map();
  for (const file of files.filter(isProductionTypeScript)) {
    const source = sourceFor(file);
    const expression = /(?:from\s+|import\s*\(|require\s*\()["'](@bitwarden\/[^"']+)["']/g;
    for (const match of source.matchAll(expression)) {
      const alias = importAlias(match[1]);
      if (!alias) {
        continue;
      }
      if (!imports.has(alias)) {
        imports.set(alias, { statements: 0, files: new Set() });
      }
      imports.get(alias).statements += 1;
      imports.get(alias).files.add(file);
    }
  }
  return [...imports.entries()]
    .map(([alias, value]) => ({
      alias,
      statements: value.statements,
      files: value.files.size,
    }))
    .sort((left, right) => right.files - left.files || right.statements - left.statements);
}

function localeInventory() {
  const definitions = [
    {
      name: "Web",
      prefix: "apps/web/src/locales/",
      english: "apps/web/src/locales/en/messages.json",
    },
    {
      name: "Browser",
      prefix: "apps/browser/src/_locales/",
      english: "apps/browser/src/_locales/en/messages.json",
    },
    {
      name: "Desktop",
      prefix: "apps/desktop/src/locales/",
      english: "apps/desktop/src/locales/en/messages.json",
    },
  ];

  const inventories = definitions.map((definition) => {
    const messageFiles = allFiles.filter(
      (file) => file.startsWith(definition.prefix) && file.endsWith("/messages.json"),
    );
    const locales = new Set(
      messageFiles.map((file) => file.slice(definition.prefix.length).split("/")[0]),
    );
    const keys = new Set(Object.keys(JSON.parse(read(definition.english))));
    return { ...definition, locales: locales.size, keys };
  });

  const [web, browser, desktop] = inventories;
  const union = new Set([...web.keys, ...browser.keys, ...desktop.keys]);
  const allThree = [...web.keys].filter(
    (key) => browser.keys.has(key) && desktop.keys.has(key),
  ).length;

  return { inventories, union: union.size, allThree };
}

function extensionInventory() {
  const mv2 = JSON.parse(read("apps/browser/src/manifest.json"));
  const mv3 = JSON.parse(read("apps/browser/src/manifest.v3.json"));
  const mv3Resources = mv3.web_accessible_resources.reduce(
    (total, group) => total + group.resources.length,
    0,
  );
  return {
    mv2: {
      version: mv2.manifest_version,
      contentScriptBlocks: mv2.content_scripts.length,
      contentScriptFiles: mv2.content_scripts.reduce(
        (total, block) => total + (block.js?.length ?? 0),
        0,
      ),
      permissions: mv2.permissions.length,
      webAccessibleResources: mv2.web_accessible_resources.length,
      background: `${mv2.background.page}, persistent=${mv2.background.persistent}`,
      csp: mv2.content_security_policy,
      sandboxPages: mv2.sandbox?.pages?.length ?? 0,
    },
    mv3: {
      version: mv3.manifest_version,
      contentScriptBlocks: mv3.content_scripts.length,
      contentScriptFiles: mv3.content_scripts.reduce(
        (total, block) => total + (block.js?.length ?? 0),
        0,
      ),
      permissions: mv3.permissions.length,
      webAccessibleResources: mv3Resources,
      background: mv3.background.service_worker,
      csp: mv3.content_security_policy.extension_pages,
      sandboxPages: mv3.sandbox?.pages?.length ?? 0,
    },
  };
}

function subSurfaceInventory() {
  const definitions = [
    {
      name: "Browser popup/sidebar Angular UI",
      files: allFiles.filter(
        (file) =>
          file.startsWith("apps/browser/src/") &&
          (file.includes("/popup/") || file.startsWith("apps/browser/src/popup/")),
      ),
    },
    {
      name: "Browser background contexts",
      files: allFiles.filter(
        (file) =>
          file.startsWith("apps/browser/src/") &&
          (file.includes("/background/") || file.endsWith(".background.ts")),
      ),
    },
    {
      name: "Browser autofill content and embedded UI",
      files: allFiles.filter(
        (file) =>
          file.startsWith("apps/browser/src/autofill/content/") ||
          file.startsWith("apps/browser/src/autofill/overlay/") ||
          file.startsWith("apps/browser/src/autofill/notification/"),
      ),
    },
    {
      name: "Desktop Electron main",
      files: allFiles.filter(
        (file) =>
          file === "apps/desktop/src/main.ts" ||
          (file.startsWith("apps/desktop/src/") &&
            (file.includes("/main/") || file.endsWith(".main.ts"))),
      ),
    },
    {
      name: "Desktop preload bridge",
      files: allFiles.filter(
        (file) =>
          file.startsWith("apps/desktop/src/") &&
          (file.endsWith("/preload.ts") || file.endsWith(".preload.ts")),
      ),
    },
  ];

  return definitions.map((definition) => ({ ...definition, ...measure(definition.files) }));
}

function frameworkNeutralCoreInventory() {
  const roots = [
    "libs/common",
    "libs/state",
    "libs/state-internal",
    "libs/storage-core",
    "libs/messaging",
    "libs/logging",
    "libs/serialization",
    "libs/user-core",
  ];

  return roots.map((root) => ({
    root,
    ...measure(allFiles.filter((file) => file.startsWith(`${root}/`))),
  }));
}

function countPatternInFiles(files, expression) {
  return files
    .filter(isProductionTypeScript)
    .reduce((total, file) => total + countMatches(stripComments(sourceFor(file)), expression), 0);
}

function themeInventory() {
  const frontendFiles = [
    ...scopeFiles.get("Web application"),
    ...scopeFiles.get("Browser extension"),
    ...scopeFiles.get("Desktop application"),
    ...scopeFiles.get("Shared libraries"),
  ];
  const productionMarkup = frontendFiles.filter(
    (file) =>
      (isProductionTypeScript(file) || file.endsWith(".html")) && !file.includes("/locales/"),
  );
  const tokenSource = read("libs/components/src/semantic-tokens.css");
  const tokenNames = new Set(tokenSource.match(/--color-[a-z0-9-]+/g) ?? []);
  const utilityFiles = productionMarkup.filter((file) =>
    /\btw-[a-z0-9-[\]]+/.test(sourceFor(file)),
  );
  return {
    colorTokens: tokenNames.size,
    utilityFiles: utilityFiles.length,
    utilityReferences: productionMarkup.reduce(
      (total, file) => total + countMatches(sourceFor(file), /\btw-[a-z0-9-[\]]+/g),
      0,
    ),
    themeClassReferences: frontendFiles
      .filter((file) => /\.(?:ts|html|css|scss)$/.test(file))
      .reduce((total, file) => total + countMatches(sourceFor(file), /theme_(?:light|dark)/g), 0),
  };
}

function upstreamChurn() {
  const log = git(["log", "-n", "250", "--format=__COMMIT__%H", "--name-only", "upstream/main"]);
  const commits = log
    .split("__COMMIT__")
    .filter(Boolean)
    .map((block) => {
      const lines = block.trim().split("\n");
      return { hash: lines[0], files: lines.slice(1).filter(Boolean) };
    });
  const churnScopes = scopes.filter((scope) => scope.name !== "Commercial overlays (read-only)");
  return {
    sampleCommits: commits.length,
    rows: churnScopes.map((scope) => {
      const matchingCommits = commits.filter((commit) =>
        commit.files.some((file) => file.startsWith(scope.prefix)),
      );
      const touchedFiles = matchingCommits.flatMap((commit) =>
        commit.files.filter((file) => file.startsWith(scope.prefix)),
      );
      return {
        name: scope.name,
        commits: matchingCommits.length,
        uniqueFiles: new Set(touchedFiles).size,
        touches: touchedFiles.length,
      };
    }),
  };
}

function refMetadata() {
  const [upstreamOnly, originOnly] = git([
    "rev-list",
    "--left-right",
    "--count",
    "upstream/main...origin/main",
  ])
    .split(/\s+/)
    .map(Number);
  return {
    originMain: git(["rev-parse", "origin/main"]),
    upstreamMain: git(["rev-parse", "upstream/main"]),
    mainMergeBase: git(["merge-base", "HEAD", "origin/main"]),
    upstreamOnly,
    originOnly,
  };
}

function renderReport() {
  const refs = refMetadata();
  const locales = localeInventory();
  const extension = extensionInventory();
  const sharedUi = sharedUiProjects();
  const frameworkNeutralCore = frameworkNeutralCoreInventory();
  const subSurfaces = subSurfaceInventory();
  const theme = themeInventory();
  const churn = upstreamChurn();
  const desktopFiles = scopeFiles.get("Desktop application");

  const lines = [
    "# Measured frontend inventory",
    "",
    "This report is generated from tracked source and configuration only. It does not build, execute, or type-check an application.",
    "",
    "## Reproduce",
    "",
    "```sh",
    "node docs/architecture/frontend-redesign/measure-frontend.mjs --check",
    "```",
    "",
    "Use `--write` to regenerate this file. The script requires only Node.js and Git; it does not read `node_modules`.",
    "",
    "## Repository point",
    "",
    markdownTable(
      ["Field", "Value"],
      [
        ["Exact consolidated baseline ancestor", `\`${baselineCommit}\``],
        ["Merge base with local `origin/main`", `\`${refs.mainMergeBase}\``],
        ["Local `origin/main`", `\`${refs.originMain}\``],
        ["Local `upstream/main`", `\`${refs.upstreamMain}\``],
        [
          "Local ref divergence (`upstream/main` only / `origin/main` only)",
          `${refs.upstreamOnly} / ${refs.originOnly}`,
        ],
      ],
    ),
    "",
    "> Counts describe the current tracked checkout. No fetch is performed; ref values are the local values present when the report is generated.",
    "",
    "## Framework and boundary inventory",
    "",
    markdownTable(
      [
        "Scope",
        "Prod TS/JS",
        "Angular files",
        "Components",
        "Directives",
        "Pipes",
        "Route paths",
        "Injectables",
        "`inject()`",
        "Provider bindings",
        "Service/state files",
      ],
      scopes.map((scope) => {
        const item = measurements.get(scope.name);
        return [
          scope.name,
          item.productionTs,
          item.angularFiles,
          item.components,
          item.directives,
          item.pipes,
          `${item.routePaths} in ${item.routeFiles} files`,
          item.injectables,
          item.injectCalls,
          item.providerBindings,
          item.serviceBoundaryFiles,
        ];
      }),
    ),
    "",
    markdownTable(
      [
        "Scope",
        "State definitions",
        "State keys",
        "Injection tokens",
        "RxJS files",
        "Lit files/elements",
        "React files",
        "Specs",
        "Stories",
      ],
      scopes.map((scope) => {
        const item = measurements.get(scope.name);
        return [
          scope.name,
          item.stateDefinitions,
          item.stateKeys,
          item.injectionTokens,
          item.rxjsFiles,
          `${item.litFiles} / ${item.litCustomElements}`,
          item.reactFiles,
          item.specs,
          item.stories,
        ];
      }),
    ),
    "",
    "Decorator counts exclude test and story files. A route path is a `path:` property in a production TypeScript file that imports `@angular/router`; it is a migration-surface proxy, not a claim that every path is reachable in every build configuration. Provider bindings count object-literal `provide:` registrations and therefore omit shorthand class providers.",
    "",
    "### Framework-neutral core check",
    "",
    markdownTable(
      ["Project", "Prod TS/JS", "Angular import files", "Service/state files", "RxJS files"],
      frameworkNeutralCore.map((item) => [
        `\`${item.root}\``,
        item.productionTs,
        item.angularFiles,
        item.serviceBoundaryFiles,
        item.rxjsFiles,
      ]),
    ),
    "",
    "These projects are not the whole domain layer, but they establish a substantial existing boundary that can be consumed without an Angular runtime.",
    "",
    "### Shared UI projects",
    "",
    markdownTable(
      ["Project", "Components", "Directives", "Pipes", "Angular files", "Stories", "Specs"],
      sharedUi.map((item) => [
        `\`${item.root}\``,
        item.components,
        item.directives,
        item.pipes,
        item.angularFiles,
        item.stories,
        item.specs,
      ]),
    ),
    "",
    "The separate browser autofill component package contributes " +
      `**${measure(allFiles.filter((file) => file.startsWith("apps/browser/src/autofill/content/components/"))).litFiles} production Lit files**, ` +
      `**${measure(allFiles.filter((file) => file.startsWith("apps/browser/src/autofill/content/components/"))).litCustomElements} registered custom element**, and ` +
      `**${measure(allFiles.filter((file) => file.startsWith("apps/browser/src/autofill/content/components/"))).stories} stories**.`,
    "",
    "### Application imports into workspace packages",
    "",
  ];

  for (const scopeName of ["Web application", "Browser extension", "Desktop application"]) {
    lines.push(`#### ${scopeName}`, "");
    lines.push(
      markdownTable(
        ["Workspace package", "Importing files", "Import statements"],
        workspaceImports(scopeFiles.get(scopeName))
          .slice(0, 15)
          .map((item) => [`\`${item.alias}\``, item.files, item.statements]),
      ),
      "",
    );
  }

  lines.push(
    "## Platform shells",
    "",
    markdownTable(
      [
        "Sub-surface",
        "Prod TS/JS",
        "Angular files",
        "Components",
        "Lit files",
        "Electron files",
        "WebExtension API files",
      ],
      subSurfaces.map((item) => [
        item.name,
        item.productionTs,
        item.angularFiles,
        item.components,
        item.litFiles,
        item.electronFiles,
        item.webExtensionApiFiles,
      ]),
    ),
    "",
    "Desktop IPC is a material non-UI boundary: production source contains " +
      `**${countPatternInFiles(desktopFiles, /\bipcMain\.(?:handle|on|once)\s*\(/g)} main-process registrations** and ` +
      `**${countPatternInFiles(desktopFiles, /\bipcRenderer\.(?:invoke|send|on|once|addListener)\s*\(/g)} renderer/preload sends or listeners**. ` +
      "The BrowserWindow configuration sets `nodeIntegration: false` and `contextIsolation: true`; the preload exposes one `ipc` object with five owned namespaces.",
    "",
    "### Extension manifest constraints",
    "",
    markdownTable(
      [
        "Manifest",
        "Content-script blocks/files",
        "Background",
        "Permissions",
        "Web-accessible resources",
        "Sandbox pages",
        "Extension-page CSP",
      ],
      [extension.mv2, extension.mv3].map((item) => [
        `MV${item.version}`,
        `${item.contentScriptBlocks} / ${item.contentScriptFiles}`,
        `\`${item.background}\``,
        item.permissions,
        item.webAccessibleResources,
        item.sandboxPages,
        `\`${item.csp}\``,
      ]),
    ),
    "",
    "The two manifest templates are transformed per Chrome, Edge, Firefox, Opera, and Safari. Webpack also emits popup, content, notification, overlay, background, and offscreen-document contexts; these are separate execution/security contexts even when they share TypeScript packages.",
    "",
    "## Localization and theming",
    "",
    markdownTable(
      ["Surface", "Locale bundles", "English keys"],
      locales.inventories.map((item) => [item.name, item.locales, item.keys.size]),
    ),
    "",
    `The three English catalogs contain **${locales.union} distinct keys**; **${locales.allThree} keys** exist in all three. Key overlap supports a shared translation contract, but the bundles are not interchangeable.`,
    "",
    markdownTable(
      ["Theme measure", "Count"],
      [
        [
          "Unique `--color-*` tokens in `libs/components/src/semantic-tokens.css`",
          theme.colorTokens,
        ],
        ["Production TS/HTML files containing prefixed Tailwind utilities", theme.utilityFiles],
        ["Prefixed Tailwind utility references", theme.utilityReferences],
        ["`theme_light` / `theme_dark` references", theme.themeClassReferences],
      ],
    ),
    "",
    "The shared Tailwind base scans shared feature libraries, while app configs add web, browser, desktop, and commercial overlay paths. Theme selection is persisted through the shared state provider and applied as `theme_light` or `theme_dark`; the web app also applies a pre-bootstrap theme to avoid a flash.",
    "",
    "## Storybook and test seams",
    "",
    markdownTable(
      ["Scope", "Specs/tests", "Stories"],
      scopes.map((scope) => {
        const item = measurements.get(scope.name);
        return [scope.name, item.specs, item.stories];
      }),
    ),
    "",
    "The root Storybook uses the Angular renderer and Compodoc, theme, accessibility, and feature-flag decorators. Browser autofill has a second Storybook using the Web Components/Vite renderer and is composed into the root Storybook. Counts show file-level seams only; they do not imply equivalent behavioral coverage.",
    "",
    "## Upstream-sync surface",
    "",
    `The local ` +
      "`origin/main` and `upstream/main` refs are aligned at the recorded base. In the latest " +
      `**${churn.sampleCommits} upstream commits** available locally:`,
    "",
    markdownTable(
      ["Scope", "Commits touching scope", "Unique files touched", "File touches"],
      churn.rows.map((item) => [item.name, item.commits, item.uniqueFiles, item.touches]),
    ),
    "",
    "This bounded churn sample is a maintenance-pressure indicator, not a forecast. A replacement that rewrites high-churn files increases recurring merge and review cost; extraction behind existing boundaries can keep upstream reconciliation file-local.",
    "",
    "## Counting limitations",
    "",
    "- All measurements are lexical and operate on tracked files. They do not resolve runtime feature flags, lazy imports, inheritance, re-exports, or commercial build selection.",
    "- Production decorator, route, and service counts exclude `*.spec.*`, `*.test.*`, story files, and directories named `spec`, `test`, or `tests`.",
    "- The browser sub-surface path groups intentionally overlap where code serves more than one extension context.",
    "- Commercial overlays are read for counts only and are not modified by this work.",
    "",
  );

  return lines.join("\n");
}

const report = `${renderReport().trimEnd()}\n`;
const argument = process.argv[2];

if (argument === "--write") {
  writeFileSync(reportPath, report);
  process.stdout.write(`${relative(repositoryRoot, reportPath)}\n`);
} else if (argument === "--check") {
  const existing = readFileSync(reportPath, "utf8");
  if (existing !== report) {
    process.stderr.write(
      `${relative(repositoryRoot, reportPath)} is stale; rerun measure-frontend.mjs --write\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`${relative(repositoryRoot, reportPath)} is current\n`);
  }
} else {
  process.stdout.write(report);
}
