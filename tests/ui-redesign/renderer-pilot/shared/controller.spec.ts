import { createRendererPilotFixture } from "./fixtures";
import { MutablePilotLocalization } from "./localization";
import { initialPilotState, reducePilotState, selectPilotViewModel } from "./state";

describe("renderer pilot state", () => {
  it("ignores stale command completion", () => {
    const pending = reducePilotState(initialPilotState, {
      type: "refreshStarted",
      requestId: 2,
    });

    expect(reducePilotState(pending, { type: "refreshCompleted", requestId: 1 })).toBe(pending);
  });

  it("maps every presentation state through the shared localization contract", () => {
    const localization = new MutablePilotLocalization("es-ES").snapshot();
    const view = selectPilotViewModel({ activity: "error", requestId: 1 }, localization);

    expect(view.locale).toBe("es-ES");
    expect(view.direction).toBe("ltr");
    expect(view.error).toBe("No se pudieron actualizar los elementos. Inténtalo de nuevo.");
  });
});

describe("RendererPilotController", () => {
  it("drives the shared error, cancellation, success, and dynamic-locale lifecycle", async () => {
    const fixture = createRendererPilotFixture();
    const activities: string[] = [];
    const unsubscribe = fixture.controller.subscribe(() => {
      activities.push(fixture.controller.snapshot().activity);
    });

    await fixture.controller.refresh();
    expect(fixture.controller.snapshot().activity).toBe("error");

    const pending = fixture.controller.refresh();
    expect(fixture.controller.snapshot().activity).toBe("pending");
    fixture.controller.cancel();
    await pending;
    expect(fixture.controller.snapshot().activity).toBe("canceled");

    fixture.localization.setLocale("ar");
    expect(fixture.controller.snapshot()).toMatchObject({
      direction: "rtl",
      locale: "ar",
      title: "لم يتم العثور على عناصر",
    });

    await fixture.controller.refresh();
    expect(fixture.controller.snapshot().activity).toBe("complete");
    expect(activities).toEqual([
      "pending",
      "error",
      "pending",
      "canceled",
      "canceled",
      "pending",
      "complete",
    ]);

    unsubscribe();
    fixture.controller.dispose();
  });
});
