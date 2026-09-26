import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  afterRenderEffect,
  input,
  signal,
  viewChild,
} from "@angular/core";

import type { PilotUnsubscribe, PilotViewModel, RendererPilotController } from "../shared";

@Component({
  selector: "ui-redesign-angular-renderer-pilot",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (viewModel(); as view) {
      <section
        class="renderer-pilot-surface"
        data-pilot-surface
        data-renderer="angular"
        [attr.aria-busy]="view.pending"
        aria-describedby="renderer-pilot-description renderer-pilot-status"
        aria-labelledby="renderer-pilot-title"
        [attr.dir]="view.direction"
        [attr.lang]="view.locale"
      >
        <h1 id="renderer-pilot-title">{{ view.title }}</h1>
        <p id="renderer-pilot-description">{{ view.description }}</p>
        <p
          id="renderer-pilot-status"
          class="renderer-pilot-status"
          role="status"
          aria-live="polite"
        >
          {{ view.status }}
        </p>
        <p class="renderer-pilot-error" role="alert" [hidden]="view.error === null">
          {{ view.error }}
        </p>
        <div class="renderer-pilot-actions">
          <button
            #refreshButton
            data-action="refresh"
            type="button"
            [disabled]="view.pending"
            (click)="refresh()"
          >
            {{ view.refreshLabel }}
          </button>
          @if (view.pending) {
            <button #cancelButton data-action="cancel" type="button" (click)="cancel()">
              {{ view.cancelLabel }}
            </button>
          }
        </div>
      </section>
    }
  `,
})
export class AngularRendererPilotComponent implements OnInit, OnDestroy {
  readonly controller = input.required<RendererPilotController>();
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>("cancelButton");
  private readonly refreshButton =
    viewChild.required<ElementRef<HTMLButtonElement>>("refreshButton");
  private readonly lastFocusedActivity = signal<PilotViewModel["activity"]>("idle");
  private readonly unsubscribe = signal<PilotUnsubscribe | null>(null);
  protected readonly viewModel = signal<PilotViewModel | null>(null);

  constructor() {
    afterRenderEffect(() => {
      const activity = this.viewModel()?.activity ?? "idle";
      if (activity === "idle" || activity === this.lastFocusedActivity()) {
        return;
      }

      const target =
        activity === "pending"
          ? this.cancelButton()?.nativeElement
          : this.refreshButton().nativeElement;
      target?.focus();
      this.lastFocusedActivity.set(activity);
    });
  }

  ngOnInit(): void {
    const controller = this.controller();
    this.viewModel.set(controller.snapshot());
    this.unsubscribe.set(
      controller.subscribe(() => {
        this.viewModel.set(controller.snapshot());
      }),
    );
  }

  ngOnDestroy(): void {
    this.unsubscribe()?.();
  }

  protected refresh(): void {
    void this.controller().refresh();
  }

  protected cancel(): void {
    this.controller().cancel();
  }
}
