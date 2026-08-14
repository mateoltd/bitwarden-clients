import type { PilotCommandPort, PilotLocale } from "./contracts";
import { RendererPilotController } from "./controller";
import { MutablePilotLocalization } from "./localization";

export type PilotCommandOutcome = "success" | "error" | "pending";

export interface RendererPilotFixture {
  readonly controller: RendererPilotController;
  readonly localization: MutablePilotLocalization;
}

export class SequencePilotCommandPort implements PilotCommandPort {
  private nextOutcome = 0;

  constructor(private readonly outcomes: readonly PilotCommandOutcome[]) {
    if (outcomes.length === 0) {
      throw new Error("At least one deterministic command outcome is required.");
    }
  }

  readonly refresh = async (signal: AbortSignal): Promise<void> => {
    const outcome = this.outcomes[Math.min(this.nextOutcome, this.outcomes.length - 1)];
    this.nextOutcome += 1;

    switch (outcome) {
      case "success":
        return;
      case "error":
        throw new Error("Deterministic non-sensitive refresh failure.");
      case "pending":
        await waitForAbort(signal);
    }
  };
}

export function createRendererPilotFixture(
  locale: PilotLocale = "en-US",
  outcomes: readonly PilotCommandOutcome[] = ["error", "pending", "success"],
): RendererPilotFixture {
  const localization = new MutablePilotLocalization(locale);
  const commands = new SequencePilotCommandPort(outcomes);

  return {
    controller: new RendererPilotController(commands, localization),
    localization,
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
