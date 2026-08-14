import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewEncapsulation,
  signal,
  viewChild,
} from "@angular/core";

import { AngularRendererPilotComponent } from "../angular/angular-renderer-pilot.component";
import type { PilotUnmount } from "../harness/page";
import { mountLitRendererPilot } from "../lit/mount";
import { mountReactRendererPilot } from "../react/mount";
import { createRendererPilotFixture } from "../shared";

@Component({
  selector: "ui-redesign-angular-renderer-pilot-story",
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [AngularRendererPilotComponent],
  styleUrl: "../pilot.css",
  template: `<main><ui-redesign-angular-renderer-pilot [controller]="fixture.controller" /></main>`,
})
export class AngularRendererPilotStoryHostComponent implements OnDestroy {
  protected readonly fixture = createRendererPilotFixture();

  ngOnDestroy(): void {
    this.fixture.controller.dispose();
  }
}

@Component({
  selector: "ui-redesign-react-renderer-pilot-story",
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: "../pilot.css",
  template: `<main><div #mount></div></main>`,
})
export class ReactRendererPilotStoryHostComponent implements AfterViewInit, OnDestroy {
  private readonly fixture = createRendererPilotFixture();
  private readonly mount = viewChild.required<ElementRef<HTMLElement>>("mount");
  private readonly unmount = signal<PilotUnmount | null>(null);

  ngAfterViewInit(): void {
    this.unmount.set(
      mountReactRendererPilot({
        controller: this.fixture.controller,
        host: this.mount().nativeElement,
      }),
    );
  }

  ngOnDestroy(): void {
    this.unmount()?.();
    this.fixture.controller.dispose();
  }
}

@Component({
  selector: "ui-redesign-lit-renderer-pilot-story",
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: "../pilot.css",
  template: `<main><div #mount></div></main>`,
})
export class LitRendererPilotStoryHostComponent implements AfterViewInit, OnDestroy {
  private readonly fixture = createRendererPilotFixture();
  private readonly mount = viewChild.required<ElementRef<HTMLElement>>("mount");
  private readonly unmount = signal<PilotUnmount | null>(null);

  ngAfterViewInit(): void {
    this.unmount.set(
      mountLitRendererPilot({
        controller: this.fixture.controller,
        host: this.mount().nativeElement,
      }),
    );
  }

  ngOnDestroy(): void {
    this.unmount()?.();
    this.fixture.controller.dispose();
  }
}
