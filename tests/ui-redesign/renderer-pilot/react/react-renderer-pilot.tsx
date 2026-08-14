import * as React from "react";

import type { RendererPilotController } from "../shared";

export interface ReactRendererPilotProps {
  readonly controller: RendererPilotController;
}

export function ReactRendererPilot({ controller }: ReactRendererPilotProps): React.JSX.Element {
  const view = React.useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const cancelButton = React.useRef<HTMLButtonElement>(null);
  const lastFocusedActivity = React.useRef(view.activity);
  const refreshButton = React.useRef<HTMLButtonElement>(null);

  React.useLayoutEffect(() => {
    if (view.activity === "idle" || view.activity === lastFocusedActivity.current) {
      return;
    }

    const target = view.activity === "pending" ? cancelButton.current : refreshButton.current;
    target?.focus();
    lastFocusedActivity.current = view.activity;
  }, [view.activity]);

  const refresh = React.useCallback((): void => {
    void controller.refresh();
  }, [controller]);
  const cancel = React.useCallback((): void => {
    controller.cancel();
  }, [controller]);

  return (
    <section
      className="renderer-pilot-surface"
      data-pilot-surface
      data-renderer="react"
      aria-busy={view.pending}
      aria-describedby="renderer-pilot-description renderer-pilot-status"
      aria-labelledby="renderer-pilot-title"
      dir={view.direction}
      lang={view.locale}
    >
      <h1 id="renderer-pilot-title">{view.title}</h1>
      <p id="renderer-pilot-description">{view.description}</p>
      <p
        id="renderer-pilot-status"
        className="renderer-pilot-status"
        role="status"
        aria-live="polite"
      >
        {view.status}
      </p>
      <p className="renderer-pilot-error" role="alert" hidden={view.error === null}>
        {view.error}
      </p>
      <div className="renderer-pilot-actions">
        <button
          ref={refreshButton}
          data-action="refresh"
          type="button"
          disabled={view.pending}
          onClick={refresh}
        >
          {view.refreshLabel}
        </button>
        {view.pending ? (
          <button ref={cancelButton} data-action="cancel" type="button" onClick={cancel}>
            {view.cancelLabel}
          </button>
        ) : null}
      </div>
    </section>
  );
}
