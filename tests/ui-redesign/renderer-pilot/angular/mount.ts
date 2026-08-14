import {
  createComponent,
  provideZonelessChangeDetection,
  type ApplicationRef,
  type ComponentRef,
} from "@angular/core";
import { createApplication } from "@angular/platform-browser";

import type { PilotMountContext, PilotUnmount } from "../harness/page";

import { AngularRendererPilotComponent } from "./angular-renderer-pilot.component";

export async function mountAngularRendererPilot({
  controller,
  host,
}: PilotMountContext): Promise<PilotUnmount> {
  const application = await createApplication({
    providers: [provideZonelessChangeDetection()],
  });
  const component = createComponent(AngularRendererPilotComponent, {
    environmentInjector: application.injector,
    hostElement: host,
  });

  attachComponent(application, component);
  component.setInput("controller", controller);
  component.changeDetectorRef.detectChanges();

  return () => {
    application.detachView(component.hostView);
    component.destroy();
    application.destroy();
  };
}

function attachComponent(
  application: ApplicationRef,
  component: ComponentRef<AngularRendererPilotComponent>,
): void {
  application.attachView(component.hostView);
}
