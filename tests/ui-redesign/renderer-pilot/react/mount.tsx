import * as React from "react";
import { createRoot } from "react-dom/client";

import type { PilotMountContext, PilotUnmount } from "../harness/page";

import { ReactRendererPilot } from "./react-renderer-pilot";

export function mountReactRendererPilot({ controller, host }: PilotMountContext): PilotUnmount {
  const root = createRoot(host);
  root.render(<ReactRendererPilot controller={controller} />);

  return () => root.unmount();
}
