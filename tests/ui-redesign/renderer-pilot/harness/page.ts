import {
  createRendererPilotFixture,
  pilotLocales,
  type PilotLocale,
  type RendererPilotController,
  type RendererPilotFixture,
} from "../shared";

export const pilotRendererNames = ["angular", "react", "lit"] as const;
export const pilotThemes = ["light", "dark"] as const;

export type PilotRendererName = (typeof pilotRendererNames)[number];
export type PilotTheme = (typeof pilotThemes)[number];
export type PilotUnmount = () => void;

export interface PilotMountContext {
  readonly controller: RendererPilotController;
  readonly host: HTMLElement;
}

export type PilotMount = (context: PilotMountContext) => PilotUnmount | Promise<PilotUnmount>;

export async function startRendererPilotPage(
  renderer: PilotRendererName,
  mount: PilotMount,
): Promise<void> {
  performance.mark("renderer-pilot-entry");

  const host = requireElement("renderer-pilot-root");
  const controls = requireElement("renderer-pilot-controls");
  const fixture = createRendererPilotFixture();
  const disposeControls = mountPilotControls(controls, fixture);
  const unmount = await mount({ controller: fixture.controller, host });

  host.dataset.renderer = renderer;
  performance.mark("renderer-pilot-mounted");

  const dispose = (): void => {
    unmount();
    disposeControls();
    fixture.controller.dispose();
  };

  globalThis.addEventListener("pagehide", dispose, { once: true });
}

function mountPilotControls(container: HTMLElement, fixture: RendererPilotFixture): PilotUnmount {
  const localeLabel = document.createElement("label");
  localeLabel.htmlFor = "renderer-pilot-locale";
  localeLabel.textContent = "Pilot locale";

  const localeSelect = document.createElement("select");
  localeSelect.id = "renderer-pilot-locale";
  localeSelect.name = "pilot-locale";
  for (const locale of pilotLocales) {
    localeSelect.append(createOption(locale, locale));
  }

  const themeLabel = document.createElement("label");
  themeLabel.htmlFor = "renderer-pilot-theme";
  themeLabel.textContent = "Pilot theme";

  const themeSelect = document.createElement("select");
  themeSelect.id = "renderer-pilot-theme";
  themeSelect.name = "pilot-theme";
  for (const theme of pilotThemes) {
    themeSelect.append(createOption(theme, theme));
  }

  const changeLocale = (): void => {
    if (isPilotLocale(localeSelect.value)) {
      fixture.localization.setLocale(localeSelect.value);
    }
  };
  const changeTheme = (): void => {
    if (isPilotTheme(themeSelect.value)) {
      applyTheme(themeSelect.value);
    }
  };
  const syncDocumentLocale = (): void => {
    const localization = fixture.localization.snapshot();
    document.documentElement.lang = localization.locale;
    document.documentElement.dir = localization.direction;
  };

  localeSelect.addEventListener("change", changeLocale);
  themeSelect.addEventListener("change", changeTheme);
  const unsubscribeLocale = fixture.localization.subscribe(syncDocumentLocale);

  container.replaceChildren(localeLabel, localeSelect, themeLabel, themeSelect);
  applyTheme("light");
  syncDocumentLocale();

  return () => {
    localeSelect.removeEventListener("change", changeLocale);
    themeSelect.removeEventListener("change", changeTheme);
    unsubscribeLocale();
  };
}

function applyTheme(theme: PilotTheme): void {
  document.documentElement.classList.remove("theme_light", "theme_dark");
  document.documentElement.classList.add(`theme_${theme}`);
  document.documentElement.style.colorScheme = theme;
}

function createOption(value: string, label: string): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function isPilotLocale(value: string): value is PilotLocale {
  return pilotLocales.some((locale) => locale === value);
}

function isPilotTheme(value: string): value is PilotTheme {
  return pilotThemes.some((theme) => theme === value);
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Renderer pilot host #${id} was not found.`);
  }
  return element;
}
