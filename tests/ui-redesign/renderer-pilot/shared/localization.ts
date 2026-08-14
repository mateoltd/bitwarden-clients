import type {
  PilotChangeListener,
  PilotLocale,
  PilotLocalizationPort,
  PilotLocalizationSnapshot,
  PilotMessageKey,
  PilotTextDirection,
  PilotUnsubscribe,
} from "./contracts";

const catalogs: Readonly<Record<PilotLocale, Readonly<Record<PilotMessageKey, string>>>> = {
  "en-US": {
    title: "No items found",
    description: "This low-privilege list is empty.",
    refresh: "Refresh",
    cancel: "Cancel refresh",
    refreshing: "Refreshing items.",
    refreshFailed: "Items could not be refreshed. Try again.",
    refreshCanceled: "Refresh canceled.",
    refreshComplete: "Items refreshed. No items found.",
  },
  "es-ES": {
    title: "No se encontraron elementos",
    description: "Esta lista de bajo privilegio está vacía.",
    refresh: "Actualizar",
    cancel: "Cancelar actualización",
    refreshing: "Actualizando elementos.",
    refreshFailed: "No se pudieron actualizar los elementos. Inténtalo de nuevo.",
    refreshCanceled: "Actualización cancelada.",
    refreshComplete: "Elementos actualizados. No se encontraron elementos.",
  },
  ar: {
    title: "لم يتم العثور على عناصر",
    description: "هذه القائمة منخفضة الصلاحيات فارغة.",
    refresh: "تحديث",
    cancel: "إلغاء التحديث",
    refreshing: "جارٍ تحديث العناصر.",
    refreshFailed: "تعذر تحديث العناصر. حاول مرة أخرى.",
    refreshCanceled: "تم إلغاء التحديث.",
    refreshComplete: "تم تحديث العناصر. لم يتم العثور على عناصر.",
  },
};

const directions: Readonly<Record<PilotLocale, PilotTextDirection>> = {
  "en-US": "ltr",
  "es-ES": "ltr",
  ar: "rtl",
};

export class MutablePilotLocalization implements PilotLocalizationPort {
  private readonly listeners = new Set<PilotChangeListener>();

  constructor(private locale: PilotLocale) {}

  readonly snapshot = (): PilotLocalizationSnapshot => ({
    locale: this.locale,
    direction: directions[this.locale],
    text: catalogs[this.locale],
  });

  readonly subscribe = (listener: PilotChangeListener): PilotUnsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setLocale(locale: PilotLocale): void {
    if (locale === this.locale) {
      return;
    }

    this.locale = locale;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
