export const pilotLocales = ["en-US", "es-ES", "ar"] as const;

export type PilotLocale = (typeof pilotLocales)[number];
export type PilotTextDirection = "ltr" | "rtl";

export const pilotMessageKeys = [
  "title",
  "description",
  "refresh",
  "cancel",
  "refreshing",
  "refreshFailed",
  "refreshCanceled",
  "refreshComplete",
] as const;

export type PilotMessageKey = (typeof pilotMessageKeys)[number];

export interface PilotLocalizationSnapshot {
  readonly locale: PilotLocale;
  readonly direction: PilotTextDirection;
  readonly text: Readonly<Record<PilotMessageKey, string>>;
}

export type PilotChangeListener = () => void;
export type PilotUnsubscribe = () => void;

export interface PilotLocalizationPort {
  readonly snapshot: () => PilotLocalizationSnapshot;
  readonly subscribe: (listener: PilotChangeListener) => PilotUnsubscribe;
}

export interface PilotCommandPort {
  readonly refresh: (signal: AbortSignal) => Promise<void>;
}

export type PilotActivity = "idle" | "pending" | "error" | "canceled" | "complete";

export interface PilotViewModel {
  readonly activity: PilotActivity;
  readonly cancelLabel: string;
  readonly description: string;
  readonly direction: PilotTextDirection;
  readonly error: string | null;
  readonly locale: PilotLocale;
  readonly pending: boolean;
  readonly refreshLabel: string;
  readonly status: string;
  readonly title: string;
}
