import type { PilotMountContext, PilotUnmount } from "../harness/page";

import {
  LitRendererPilotElement,
  defineLitRendererPilotElement,
  litRendererPilotTag,
} from "./lit-renderer-pilot.element";

export function mountLitRendererPilot({ controller, host }: PilotMountContext): PilotUnmount {
  defineLitRendererPilotElement(globalThis.customElements);
  const element = document.createElement(litRendererPilotTag);

  if (!(element instanceof LitRendererPilotElement)) {
    throw new Error("The Lit renderer pilot custom element was not registered.");
  }

  element.initialize(controller);
  host.replaceChildren(element);

  return () => element.remove();
}
