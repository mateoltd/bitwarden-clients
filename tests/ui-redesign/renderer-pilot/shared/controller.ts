import type {
  PilotChangeListener,
  PilotCommandPort,
  PilotLocalizationPort,
  PilotUnsubscribe,
  PilotViewModel,
} from "./contracts";
import {
  initialPilotState,
  reducePilotState,
  selectPilotViewModel,
  type PilotEvent,
  type PilotState,
} from "./state";

export class RendererPilotController {
  private readonly listeners = new Set<PilotChangeListener>();
  private readonly unsubscribeLocalization: PilotUnsubscribe;
  private activeCommand: AbortController | null = null;
  private disposed = false;
  private nextRequestId = 1;
  private state: PilotState = initialPilotState;
  private viewModel: PilotViewModel;

  constructor(
    private readonly commands: PilotCommandPort,
    private readonly localization: PilotLocalizationPort,
  ) {
    this.viewModel = selectPilotViewModel(this.state, this.localization.snapshot());
    this.unsubscribeLocalization = this.localization.subscribe(() => {
      this.updateViewModel();
    });
  }

  readonly snapshot = (): PilotViewModel => this.viewModel;

  readonly subscribe = (listener: PilotChangeListener): PilotUnsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async refresh(): Promise<void> {
    if (this.disposed || this.activeCommand !== null) {
      return;
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    const command = new AbortController();
    this.activeCommand = command;
    this.transition({ type: "refreshStarted", requestId });

    try {
      await this.commands.refresh(command.signal);
      this.transition({
        type: command.signal.aborted ? "refreshCanceled" : "refreshCompleted",
        requestId,
      });
    } catch {
      this.transition({
        type: command.signal.aborted ? "refreshCanceled" : "refreshFailed",
        requestId,
      });
    } finally {
      if (this.activeCommand === command) {
        this.activeCommand = null;
      }
    }
  }

  cancel(): void {
    this.activeCommand?.abort();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.activeCommand?.abort();
    this.activeCommand = null;
    this.unsubscribeLocalization();
    this.listeners.clear();
  }

  private transition(event: PilotEvent): void {
    if (this.disposed) {
      return;
    }

    this.state = reducePilotState(this.state, event);
    this.updateViewModel();
  }

  private updateViewModel(): void {
    this.viewModel = selectPilotViewModel(this.state, this.localization.snapshot());
    for (const listener of this.listeners) {
      listener();
    }
  }
}
