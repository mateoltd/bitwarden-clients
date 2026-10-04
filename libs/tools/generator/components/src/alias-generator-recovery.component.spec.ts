import { LiveAnnouncer } from "@angular/cdk/a11y";
import { NgZone } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { FormBuilder } from "@angular/forms";
import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject, firstValueFrom, mergeMap, of, Subject, throwError } from "rxjs";

import { Account, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import { appendAliasSyncEvent, createAliasSyncDocument } from "@bitwarden/common/tools/alias";
import { Vendor } from "@bitwarden/common/tools/extension/vendor/data";
import { UserStateSubject } from "@bitwarden/common/tools/state/user-state-subject";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import {
  createAliasConnectionCipher,
  parseAliasConnectionCipher,
} from "@bitwarden/common/vault/alias-connection";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { ToastService } from "@bitwarden/components";
import {
  CredentialGeneratorService,
  ForwarderOptions,
  GeneratedCredential,
  GeneratorMetadata,
  SimpleLoginAliasError,
  Type,
} from "@bitwarden/generator-core";
import { GeneratorHistoryService } from "@bitwarden/generator-history";

import { ForwarderSettingsComponent } from "./forwarder-settings.component";
import { UsernameGeneratorComponent } from "./username-generator.component";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const account = { id: "user-1" as UserId } as Account;
const connectionId = "11111111-1111-4111-8111-111111111111";
const i18n = { t: (key: string, ...values: string[]) => [key, ...values].join(" ") } as I18nService;

describe("alias forwarder settings recovery", () => {
  let component: ForwarderSettingsComponent;
  let generator: MockProxy<CredentialGeneratorService>;
  let toast: MockProxy<ToastService>;
  let sync: MockProxy<SyncService>;
  let cipherService: MockProxy<CipherService>;
  let stored: Map<string, ForwarderOptions>;
  let carriers: CipherView[];
  let writes: { userId: string; value: ForwarderOptions }[];

  beforeEach(async () => {
    generator = mock<CredentialGeneratorService>();
    toast = mock<ToastService>();
    sync = mock<SyncService>();
    cipherService = mock<CipherService>();
    writes = [];
    const journal = appendAliasSyncEvent(createAliasSyncDocument(), {
      kind: "connection-upsert",
      connection: { version: 1, connectionId },
    });
    stored = new Map([
      [
        account.id,
        {
          token: "provider-secret",
          baseUrl: "https://app.simplelogin.io/",
          connectionId,
          aliasSync: journal,
        },
      ],
    ]);
    carriers = [
      createAliasConnectionCipher({
        version: 1,
        connection: { version: 1, connectionId },
        credential: { token: "provider-secret", baseUrl: "https://app.simplelogin.io/" },
        sync: journal,
      }),
    ];
    cipherService.getAllDecryptedIncludingInternal.mockImplementation(async () => carriers);
    cipherService.createWithServer.mockImplementation(async (cipher) => {
      carriers.push(cipher);
      return cipher;
    });
    generator.forwarder.mockReturnValue({
      capabilities: { fields: ["token", "baseUrl"] },
    } as GeneratorMetadata<ForwarderOptions>);
    generator.settings.mockImplementation((_metadata, { account$ }) => {
      const subject = new BehaviorSubject<ForwarderOptions>({});
      let userId: string;
      const emit = subject.next.bind(subject);
      const subscription = account$.subscribe((current) => {
        userId = current.id;
        emit(stored.get(userId) ?? {});
      });
      jest.spyOn(subject, "next").mockImplementation((value) => {
        stored.set(userId, value);
        writes.push({ userId, value });
        emit(value);
      });
      const complete = subject.complete.bind(subject);
      jest.spyOn(subject, "complete").mockImplementation(() => {
        subscription.unsubscribe();
        complete();
      });
      return subject as unknown as UserStateSubject<ForwarderOptions>;
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: ToastService, useValue: toast },
        { provide: I18nService, useValue: i18n },
        { provide: CipherService, useValue: cipherService },
        { provide: SyncService, useValue: sync },
      ],
    });
    component = TestBed.runInInjectionContext(
      () => new ForwarderSettingsComponent(new FormBuilder(), generator),
    );
    component.account = account;
    component.forwarder = Vendor.simplelogin;
    await component.ngOnChanges({ account: {} as never, forwarder: {} as never });
    await component.ngOnInit();
  });

  afterEach(() => component.ngOnDestroy());

  it("keeps the removal tombstone in the old carrier and reconnects with a fresh identity", async () => {
    component["settings"].patchValue({ token: "" });
    component.save();
    await flush();
    await flush();
    expect(stored.get(account.id)?.token).toBe("");
    const oldCarriers = carriers.map(parseAliasConnectionCipher);
    expect(
      oldCarriers.some((carrier) =>
        carrier.sync.events.some((event) => event.kind === "connection-remove"),
      ),
    ).toBe(true);

    component["settings"].patchValue({ token: "new-secret" });
    component.save();
    await flush();
    const reconnected = stored.get(account.id)!;
    expect(reconnected.connectionId).not.toBe(connectionId);
    expect(reconnected.aliasSync?.events).toEqual([]);
    expect(carriers.map(parseAliasConnectionCipher)).toEqual(oldCarriers);
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it("reconnects a tombstoned identity even when an interrupted removal left the old token", async () => {
    const current = stored.get(account.id)!;
    const removed = appendAliasSyncEvent(current.aliasSync!, {
      kind: "connection-remove",
      connection: { version: 1, connectionId },
    });
    stored.set(account.id, { ...current, aliasSync: removed });
    component["settings"].patchValue({ token: current.token });
    component.save();
    await flush();
    expect(stored.get(account.id)?.connectionId).not.toBe(connectionId);
    expect(stored.get(account.id)?.aliasSync?.events).toEqual([]);
    expect(removed.events.at(-1)?.kind).toBe("connection-remove");
  });

  it("reports a safe failure and accepts a later save", async () => {
    cipherService.getAllDecryptedIncludingInternal.mockRejectedValueOnce(
      new Error("provider-secret"),
    );
    component["settings"].patchValue({ token: "" });
    component.save();
    await flush();
    expect(toast.showToast).toHaveBeenCalledWith({
      variant: "error",
      title: "",
      message: "unexpectedError",
    });
    component.save();
    await flush();
    await flush();
    expect(stored.get(account.id)?.token).toBe("");
    expect(JSON.stringify(toast.showToast.mock.calls)).not.toContain("provider-secret");
  });

  it("does not save old input into a new account while removal is in flight", async () => {
    let release!: (value: CipherView[]) => void;
    cipherService.getAllDecryptedIncludingInternal.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    component["settings"].patchValue({ token: "" });
    component.save();
    await flush();
    component.account = { id: "user-2" as UserId } as Account;
    await component.ngOnChanges({ account: {} as never });
    release(carriers);
    await flush();
    await flush();
    expect(writes.every((write) => write.userId === account.id)).toBe(true);
    expect(stored.get("user-2")).toBeUndefined();
    expect(toast.showToast).not.toHaveBeenCalled();
  });
});

describe("alias username generator errors", () => {
  it.each([
    [new SimpleLoginAliasError("provider-secret", "invalid-credentials"), "aliasUnknownError"],
    [new SimpleLoginAliasError("provider-secret", "rate-limited", 429, 60), "aliasRateLimited 60"],
    [new Error("provider-secret"), "unexpectedError"],
    ["Existing localized forwarder message", "Existing localized forwarder message"],
  ])("shows safe feedback and accepts the next explicit request (%s)", async (error, message) => {
    const generator = mock<CredentialGeneratorService>();
    const toast = mock<ToastService>();
    const log = mock<LogService>();
    const history = mock<GeneratorHistoryService>();
    history.track.mockResolvedValue(undefined);
    generator.algorithms$.mockReturnValue(of([]));
    generator.preferences.mockReturnValue(new Subject() as never);
    let attempts = 0;
    const credential = new GeneratedCredential("alias@example.com", Type.email, 1);
    generator.generate$.mockImplementation(({ on$ }) =>
      on$.pipe(mergeMap(() => (++attempts === 1 ? throwError(() => error) : of(credential)))),
    );
    const component = new UsernameGeneratorComponent(
      generator,
      history,
      toast,
      log,
      i18n,
      mock<AccountService>(),
      new NgZone({ enableLongStackTrace: false }),
      new FormBuilder(),
      mock<LiveAnnouncer>(),
    );
    component.account = account;
    component["account$"].next(account);
    await component.ngOnInit();
    component["maybeAlgorithm$"].next(null);
    const request = { source: "user request", algorithm: { forwarder: Vendor.simplelogin } };
    component["generate$"].next(request);
    expect(toast.showToast).toHaveBeenCalledWith({ variant: "error", title: "", message });
    expect(log.error).not.toHaveBeenCalled();
    expect(attempts).toBe(1);
    component["generate$"].next(request);
    expect(attempts).toBe(2);
    expect(await firstValueFrom(component["value$"])).toBe(credential.credential);
    component.ngOnDestroy();
  });
});
