import type { PilotActivity, PilotLocalizationSnapshot, PilotViewModel } from "./contracts";

export interface PilotState {
  readonly activity: PilotActivity;
  readonly requestId: number;
}

export type PilotEvent =
  | { readonly type: "refreshStarted"; readonly requestId: number }
  | { readonly type: "refreshCompleted"; readonly requestId: number }
  | { readonly type: "refreshFailed"; readonly requestId: number }
  | { readonly type: "refreshCanceled"; readonly requestId: number };

export const initialPilotState: PilotState = {
  activity: "idle",
  requestId: 0,
};

export function reducePilotState(state: PilotState, event: PilotEvent): PilotState {
  switch (event.type) {
    case "refreshStarted":
      return { activity: "pending", requestId: event.requestId };
    case "refreshCompleted":
      return event.requestId === state.requestId
        ? { activity: "complete", requestId: state.requestId }
        : state;
    case "refreshFailed":
      return event.requestId === state.requestId
        ? { activity: "error", requestId: state.requestId }
        : state;
    case "refreshCanceled":
      return event.requestId === state.requestId
        ? { activity: "canceled", requestId: state.requestId }
        : state;
  }
}

export function selectPilotViewModel(
  state: PilotState,
  localization: PilotLocalizationSnapshot,
): PilotViewModel {
  const status = selectStatus(state.activity, localization);

  return {
    activity: state.activity,
    cancelLabel: localization.text.cancel,
    description: localization.text.description,
    direction: localization.direction,
    error: state.activity === "error" ? localization.text.refreshFailed : null,
    locale: localization.locale,
    pending: state.activity === "pending",
    refreshLabel: localization.text.refresh,
    status,
    title: localization.text.title,
  };
}

function selectStatus(activity: PilotActivity, localization: PilotLocalizationSnapshot): string {
  switch (activity) {
    case "idle":
    case "error":
      return "";
    case "pending":
      return localization.text.refreshing;
    case "canceled":
      return localization.text.refreshCanceled;
    case "complete":
      return localization.text.refreshComplete;
  }
}
