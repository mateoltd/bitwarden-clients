import { LitElement, html, nothing, type TemplateResult } from "lit";

import type { PilotUnsubscribe, PilotViewModel, RendererPilotController } from "../shared";

export const litRendererPilotTag = "ui-redesign-lit-renderer-pilot";

export class LitRendererPilotElement extends LitElement {
  private controllerValue: RendererPilotController | null = null;
  private lastFocusedActivity: PilotViewModel["activity"] = "idle";
  private unsubscribe: PilotUnsubscribe | null = null;
  private viewModel: PilotViewModel | null = null;

  initialize(controller: RendererPilotController): void {
    if (this.controllerValue !== null) {
      throw new Error("The Lit renderer pilot controller is a write-once input.");
    }

    this.controllerValue = controller;
    this.viewModel = controller.snapshot();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    const controller = this.requireController();
    this.unsubscribe = controller.subscribe(() => {
      this.viewModel = controller.snapshot();
      this.requestUpdate();
    });
  }

  override disconnectedCallback(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    super.disconnectedCallback();
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  protected override render(): TemplateResult {
    const view = this.viewModel ?? this.requireController().snapshot();

    return html`
      <section
        class="renderer-pilot-surface"
        data-pilot-surface
        data-renderer="lit"
        aria-busy=${String(view.pending)}
        aria-describedby="renderer-pilot-description renderer-pilot-status"
        aria-labelledby="renderer-pilot-title"
        dir=${view.direction}
        lang=${view.locale}
      >
        <h1 id="renderer-pilot-title">${view.title}</h1>
        <p id="renderer-pilot-description">${view.description}</p>
        <p
          id="renderer-pilot-status"
          class="renderer-pilot-status"
          role="status"
          aria-live="polite"
        >
          ${view.status}
        </p>
        <p class="renderer-pilot-error" role="alert" ?hidden=${view.error === null}>
          ${view.error}
        </p>
        <div class="renderer-pilot-actions">
          <button
            data-action="refresh"
            type="button"
            ?disabled=${view.pending}
            @click=${this.refresh}
          >
            ${view.refreshLabel}
          </button>
          ${
            view.pending
              ? html`<button data-action="cancel" type="button" @click=${this.cancel}>
                  ${view.cancelLabel}
                </button>`
              : nothing
          }
        </div>
      </section>
    `;
  }

  protected override updated(): void {
    const activity = this.viewModel?.activity ?? "idle";
    if (activity === "idle" || activity === this.lastFocusedActivity) {
      return;
    }

    const action = activity === "pending" ? "cancel" : "refresh";
    this.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)?.focus();
    this.lastFocusedActivity = activity;
  }

  private readonly refresh = (): void => {
    void this.requireController().refresh();
  };

  private readonly cancel = (): void => {
    this.requireController().cancel();
  };

  private requireController(): RendererPilotController {
    if (this.controllerValue === null) {
      throw new Error("The Lit renderer pilot requires a controller before connection.");
    }
    return this.controllerValue;
  }
}

export function defineLitRendererPilotElement(registry: CustomElementRegistry): void {
  if (registry.get(litRendererPilotTag) === undefined) {
    registry.define(litRendererPilotTag, LitRendererPilotElement);
  }
}
