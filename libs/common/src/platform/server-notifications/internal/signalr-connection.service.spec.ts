import { HubConnectionState, ILogger, LogLevel } from "@microsoft/signalr";
import { mock, MockProxy } from "jest-mock-extended";

import { awaitAsync } from "../../../../spec";
import { ApiService } from "../../../abstractions/api.service";
import { UserId } from "../../../types/guid";
import { LogService } from "../../abstractions/log.service";
import { PlatformUtilsService } from "../../abstractions/platform-utils.service";

import {
  SignalRConnectionService,
  SignalRNotification,
  TimeoutManager,
} from "./signalr-connection.service";

describe("SignalRConnectionService", () => {
  const userId = "user-1" as UserId;
  const notificationsUrl = "https://notifications.example.com";

  let apiService: MockProxy<ApiService>;
  let logService: MockProxy<LogService>;
  let platformUtilsService: MockProxy<PlatformUtilsService>;
  let timeoutManager: MockProxy<TimeoutManager>;

  let connection: {
    on: jest.Mock;
    onclose: jest.Mock;
    start: jest.Mock;
    stop: jest.Mock;
    state: HubConnectionState;
  };
  let signalRLogger: ILogger;

  let sut: SignalRConnectionService;

  beforeEach(() => {
    apiService = mock<ApiService>();
    logService = mock<LogService>();
    platformUtilsService = mock<PlatformUtilsService>();
    timeoutManager = mock<TimeoutManager>();

    connection = {
      on: jest.fn(),
      onclose: jest.fn(),
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      state: HubConnectionState.Disconnected,
    };

    const builder: {
      withUrl: jest.Mock;
      withHubProtocol: jest.Mock;
      configureLogging: jest.Mock;
      build: jest.Mock;
    } = {
      withUrl: jest.fn().mockReturnThis(),
      withHubProtocol: jest.fn().mockReturnThis(),
      configureLogging: jest.fn((logger: ILogger) => {
        signalRLogger = logger;
        return builder;
      }),
      build: jest.fn().mockReturnValue(connection),
    };

    sut = new SignalRConnectionService(
      apiService,
      logService,
      platformUtilsService,
      () => builder as any,
      timeoutManager,
    );
  });

  it("emits Connected when the connection starts successfully", async () => {
    const received: SignalRNotification[] = [];
    const subscription = sut.connect$(userId, notificationsUrl).subscribe((n) => received.push(n));
    await awaitAsync(1);

    expect(received).toEqual([{ type: "Connected" }]);
    subscription.unsubscribe();
  });

  it("does not emit Connected when the connection fails to start", async () => {
    connection.start.mockRejectedValue(new Error("connect failed"));

    const received: SignalRNotification[] = [];
    const subscription = sut.connect$(userId, notificationsUrl).subscribe((n) => received.push(n));
    await awaitAsync(1);

    expect(received).toEqual([]);
    subscription.unsubscribe();
  });

  it("emits Connected again after a successful scheduled reconnect", async () => {
    const received: SignalRNotification[] = [];
    const subscription = sut.connect$(userId, notificationsUrl).subscribe((n) => received.push(n));
    await awaitAsync(1);
    expect(received).toEqual([{ type: "Connected" }]);

    // Simulate the server dropping the connection.
    const oncloseCallback = connection.onclose.mock.calls[0][0];
    connection.state = HubConnectionState.Disconnected;
    oncloseCallback(undefined);

    // Run the scheduled reconnect immediately.
    const reconnectHandler = timeoutManager.setTimeout.mock.calls[0][0] as () => void;
    reconnectHandler();
    await awaitAsync(1);

    expect(received).toEqual([{ type: "Connected" }, { type: "Connected" }]);
    subscription.unsubscribe();
  });

  it("redacts access tokens from WebSocket diagnostics without discarding the error context", () => {
    const subscription = sut.connect$(userId, notificationsUrl).subscribe();
    const secret = "bitwarden-access-token";

    signalRLogger.log(
      LogLevel.Error,
      `WebSocket connection to 'wss://notifications.example/hub?access_token=${secret}&id=42' failed`,
    );

    expect(logService.error).toHaveBeenCalledWith(
      "[SignalR] WebSocket connection to 'wss://notifications.example/hub?access_token=[REDACTED]&id=42' failed",
    );
    expect(logService.error.mock.calls.flat().join(" ")).not.toContain(secret);
    subscription.unsubscribe();
  });

  it("redacts encoded query tokens and authorization headers from diagnostics", () => {
    const subscription = sut.connect$(userId, notificationsUrl).subscribe();
    const encodedSecret = "encoded-access-token";
    const bearerSecret = "bearer-access-token";

    signalRLogger.log(
      LogLevel.Error,
      `url=wss%3A%2F%2Fnotifications.example%2Fhub%3Faccess_token%3D${encodedSecret}%26id%3D42 Authorization: Bearer ${bearerSecret}`,
    );

    const logged = logService.error.mock.calls.flat().join(" ");
    expect(logged).toContain("access_token%3D[REDACTED]%26id%3D42");
    expect(logged).toContain("Authorization: Bearer [REDACTED]");
    expect(logged).not.toContain(encodedSecret);
    expect(logged).not.toContain(bearerSecret);
    subscription.unsubscribe();
  });

  it("redacts tokens from connection shutdown errors", async () => {
    const secret = "shutdown-access-token";
    connection.stop.mockRejectedValue(
      new Error(`stop failed for wss://notifications.example/hub?access_token=${secret}&id=42`),
    );
    const subscription = sut.connect$(userId, notificationsUrl).subscribe();

    subscription.unsubscribe();
    await awaitAsync(1);

    const logged = logService.error.mock.calls.flat().join(" ");
    expect(logged).toContain("access_token=[REDACTED]&id=42");
    expect(logged).not.toContain(secret);
  });
});
