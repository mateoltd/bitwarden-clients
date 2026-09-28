import {
  HttpTransportType,
  HubConnectionBuilder,
  HubConnectionState,
  ILogger,
  LogLevel,
} from "@microsoft/signalr";
import { MessagePackHubProtocol } from "@microsoft/signalr-protocol-msgpack";
import { Observable, Subscription } from "rxjs";

import { ApiService } from "../../../abstractions/api.service";
import { NotificationResponse } from "../../../models/response/notification.response";
import { InsecureUrlNotAllowedError } from "../../../services/api-errors";
import { UserId } from "../../../types/guid";
import { LogService } from "../../abstractions/log.service";
import { PlatformUtilsService } from "../../abstractions/platform-utils.service";

// 2 Minutes
const MIN_RECONNECT_TIME = 2 * 60 * 1000;
// 5 Minutes
const MAX_RECONNECT_TIME = 5 * 60 * 1000;

export type Connected = { type: "Connected" };
export type Heartbeat = { type: "Heartbeat" };
export type ReceiveMessage = { type: "ReceiveMessage"; message: NotificationResponse };

export type SignalRNotification = Connected | Heartbeat | ReceiveMessage;

export type TimeoutManager = {
  setTimeout: (handler: TimerHandler, timeout: number) => number;
  clearTimeout: (timeoutId: number) => void;
};

function redactSignalRMessage(message: string): string {
  return message
    .replace(/([?&]access_token=)[^&\s"']*/gi, "$1[REDACTED]")
    .replace(/((?:%3f|%26)access_token%3d)(?:(?!%26)[^\s"'])*/gi, "$1[REDACTED]")
    .replace(
      /\b((?:authorization|authentication)["']?\s*[:=]\s*["']?(?:bearer\s+)?)[^\s"',;}]+/gi,
      "$1[REDACTED]",
    );
}

function safeSignalRError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSignalRMessage(message)
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 512);
}

class SignalRLogger implements ILogger {
  constructor(private readonly logService: LogService) {}

  redactMessage(message: string): string {
    // SignalR sends its bearer token in the WebSocket query string. Chromium can include that URL
    // in failure diagnostics, so redact every occurrence while preserving non-sensitive context.
    return redactSignalRMessage(message);
  }

  log(logLevel: LogLevel, message: string): void {
    const redactedMessage = `[SignalR] ${this.redactMessage(message)}`;

    switch (logLevel) {
      case LogLevel.Critical:
        this.logService.error(redactedMessage);
        break;
      case LogLevel.Error:
        this.logService.error(redactedMessage);
        break;
      case LogLevel.Warning:
        this.logService.warning(redactedMessage);
        break;
      case LogLevel.Information:
        this.logService.info(redactedMessage);
        break;
      case LogLevel.Debug:
        this.logService.debug(redactedMessage);
        break;
    }
  }
}

export class SignalRConnectionService {
  constructor(
    private readonly apiService: ApiService,
    private readonly logService: LogService,
    private readonly platformUtilsService: PlatformUtilsService,
    private readonly hubConnectionBuilderFactory: () => HubConnectionBuilder = () =>
      new HubConnectionBuilder(),
    private readonly timeoutManager: TimeoutManager = globalThis,
  ) {}

  connect$(userId: UserId, notificationsUrl: string) {
    if (!notificationsUrl.startsWith("https://") && !this.platformUtilsService.isDev()) {
      throw new InsecureUrlNotAllowedError();
    }

    return new Observable<SignalRNotification>((subscriber) => {
      const connection = this.hubConnectionBuilderFactory()
        .withUrl(notificationsUrl + "/hub", {
          accessTokenFactory: () => this.apiService.getActiveBearerToken(userId),
          skipNegotiation: true,
          transport: HttpTransportType.WebSockets,
        })
        .withHubProtocol(new MessagePackHubProtocol())
        .configureLogging(new SignalRLogger(this.logService))
        .build();

      connection.on("ReceiveMessage", (data: any) => {
        subscriber.next({ type: "ReceiveMessage", message: new NotificationResponse(data) });
      });

      connection.on("Heartbeat", () => {
        subscriber.next({ type: "Heartbeat" });
      });

      let reconnectSubscription: Subscription | null = null;

      // Create schedule reconnect function
      const scheduleReconnect = () => {
        if (
          connection == null ||
          connection.state !== HubConnectionState.Disconnected ||
          (reconnectSubscription != null && !reconnectSubscription.closed)
        ) {
          // Skip scheduling a new reconnect, either the connection isn't disconnected
          // or an active reconnect is already scheduled.
          return;
        }

        // If we've somehow gotten here while the subscriber is closed,
        // we do not want to reconnect. So leave.
        if (subscriber.closed) {
          return;
        }

        const randomTime = this.randomReconnectTime();
        const timeoutHandler = this.timeoutManager.setTimeout(() => {
          connection
            .start()
            .then(() => {
              reconnectSubscription = null;
              subscriber.next({ type: "Connected" });
            })
            .catch(() => {
              scheduleReconnect();
            });
        }, randomTime);

        reconnectSubscription = new Subscription(() =>
          this.timeoutManager.clearTimeout(timeoutHandler),
        );
      };

      connection.onclose((error) => {
        scheduleReconnect();
      });

      // Start connection
      connection
        .start()
        .then(() => {
          subscriber.next({ type: "Connected" });
        })
        .catch(() => {
          scheduleReconnect();
        });

      return () => {
        // Cancel any possible scheduled reconnects
        reconnectSubscription?.unsubscribe();
        connection?.stop().catch((error) => {
          this.logService.error(
            `Error while stopping SignalR connection: ${safeSignalRError(error)}`,
          );
        });
      };
    });
  }

  private randomReconnectTime() {
    return (
      Math.floor(Math.random() * (MAX_RECONNECT_TIME - MIN_RECONNECT_TIME + 1)) + MIN_RECONNECT_TIME
    );
  }
}
