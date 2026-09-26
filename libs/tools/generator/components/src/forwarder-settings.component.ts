import {
  Component,
  EventEmitter,
  Input,
  inject,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
} from "@angular/core";
import { FormBuilder, ReactiveFormsModule } from "@angular/forms";
import {
  concatMap,
  filter,
  firstValueFrom,
  map,
  merge,
  ReplaySubject,
  skip,
  Subject,
  switchAll,
  takeUntil,
  withLatestFrom,
} from "rxjs";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { Account } from "@bitwarden/common/auth/abstractions/account.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import {
  aliasConnectionKey,
  createAliasSyncDocument,
  projectAliasSync,
} from "@bitwarden/common/tools/alias";
import { VendorId } from "@bitwarden/common/tools/extension";
import { Vendor } from "@bitwarden/common/tools/extension/vendor/data";
import { UserStateSubject } from "@bitwarden/common/tools/state/user-state-subject";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import {
  FormFieldModule,
  AriaDisableDirective,
  TooltipDirective,
  BitIconButtonComponent,
  CheckboxModule,
  ToastService,
} from "@bitwarden/components";
import {
  CredentialGeneratorService,
  attachSimpleLoginAliasSyncStore,
  createSimpleLoginAliasService,
  createSimpleLoginConnectionId,
  ForwarderOptions,
  GeneratorMetadata,
  isSimpleLoginConnectionId,
  simpleLoginAliasSyncStore,
} from "@bitwarden/generator-core";
import { I18nPipe } from "@bitwarden/ui-common";

const Controls = Object.freeze({
  domain: "domain",
  token: "token",
  baseUrl: "baseUrl",
  prefix: "prefix",
});

/** Options group for forwarder integrations */
// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "tools-forwarder-settings",
  templateUrl: "forwarder-settings.component.html",
  imports: [
    ReactiveFormsModule,
    FormFieldModule,
    AriaDisableDirective,
    TooltipDirective,
    BitIconButtonComponent,
    CheckboxModule,
    JslibModule,
    I18nPipe,
  ],
})
export class ForwarderSettingsComponent implements OnInit, OnChanges, OnDestroy {
  private readonly toastService = inject(ToastService);
  private readonly i18nService = inject(I18nService);
  private readonly cipherService = inject(CipherService, { optional: true }) ?? undefined;
  private readonly syncService = inject(SyncService, { optional: true }) ?? undefined;
  /** Instantiates the component
   *  @param generatorService settings and policy logic
   *  @param formBuilder reactive form controls
   */
  constructor(
    private formBuilder: FormBuilder,
    private generatorService: CredentialGeneratorService,
  ) {}

  /** Binds the component to a specific user's settings.
   *  @remarks this is initialized to null but since it's a required input it'll
   *     never have that value in practice.
   */
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-signals
  @Input({ required: true })
  account: Account = null!;

  protected account$ = new ReplaySubject<Account>(1);

  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-signals
  @Input({ required: true })
  forwarder: VendorId = null!;

  /** Emits settings updates and completes if the settings become unavailable.
   * @remarks this does not emit the initial settings. If you would like
   *   to receive live settings updates including the initial update,
   *   use `CredentialGeneratorService.settings$(...)` instead.
   */
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-output-emitter-ref
  @Output()
  readonly onUpdated = new EventEmitter<unknown>();

  /** The template's control bindings */
  protected settings = this.formBuilder.group({
    [Controls.domain]: [""],
    [Controls.token]: [""],
    [Controls.baseUrl]: [""],
    [Controls.prefix]: [false],
  });

  private vendor = new ReplaySubject<VendorId>(1);

  async ngOnInit() {
    const forwarder$ = new ReplaySubject<GeneratorMetadata<ForwarderOptions>>(1);
    this.vendor
      .pipe(
        map((vendor) => this.generatorService.forwarder(vendor)),
        takeUntil(this.destroyed$),
      )
      .subscribe((forwarder) => {
        this.displayDomain = forwarder.capabilities.fields.includes("domain");
        this.displayToken = forwarder.capabilities.fields.includes("token");
        this.displayBaseUrl = forwarder.capabilities.fields.includes("baseUrl");
        this.displayPrefix = forwarder.capabilities.fields.includes("prefix");

        forwarder$.next(forwarder);
      });

    const settings$ = forwarder$.pipe(
      map((forwarder) => this.generatorService.settings(forwarder, { account$: this.account$ })),
    );

    // bind settings to the reactive form
    settings$.pipe(switchAll(), takeUntil(this.destroyed$)).subscribe((settings) => {
      // skips reactive event emissions to break a subscription cycle
      // convert prefix sentinel string to boolean for the checkbox control
      const patchValues = { ...(settings as any), prefix: (settings as any).prefix === "website" };
      this.settings.patchValue(patchValues, { emitEvent: false });
    });

    // enable requested forwarder inputs
    forwarder$.pipe(takeUntil(this.destroyed$)).subscribe((forwarder) => {
      for (const name in Controls) {
        const control = this.settings.get(name);
        if (forwarder.capabilities.fields.includes(name)) {
          control?.enable({ emitEvent: false });
        } else {
          control?.disable({ emitEvent: false });
        }
      }
    });

    // the first emission is the current value; subsequent emissions are updates
    settings$
      .pipe(
        map((settings$) => settings$.pipe(skip(1))),
        switchAll(),
        takeUntil(this.destroyed$),
      )
      .subscribe(this.onUpdated);

    // now that outputs are set up, connect inputs
    this.saveSettings
      .pipe(
        withLatestFrom(this.settings.valueChanges, this.account$, this.vendor),
        concatMap(async ([, value, account, vendor]) => {
          if (
            this.componentDestroyed ||
            this.account?.id !== account.id ||
            this.forwarder !== vendor
          ) {
            return;
          }
          // Bind each save to the account that requested it, even if the component switches
          // accounts while a connection removal is syncing its encrypted carrier.
          const cancelled$ = merge(
            this.destroyed$,
            this.account$.pipe(filter((active) => active.id !== account.id)),
            this.vendor.pipe(filter((active) => active !== vendor)),
          );
          const account$ = new ReplaySubject<Account>(1);
          account$.next(account);
          let settings: UserStateSubject<ForwarderOptions> | undefined;
          try {
            settings = this.generatorService.settings<ForwarderOptions>(
              this.generatorService.forwarder(vendor),
              { account$ },
            );
            const current = await firstValueFrom(settings.pipe(takeUntil(cancelled$)));
            const saveValues: ForwarderOptions = {
              ...current,
              domain: value.domain ?? undefined,
              token: value.token ?? undefined,
              baseUrl: value.baseUrl ?? undefined,
              prefix: value.prefix ? "website" : "",
            };
            const removedConnection =
              vendor === Vendor.simplelogin &&
              current.aliasSync &&
              isSimpleLoginConnectionId(current.connectionId) &&
              projectAliasSync(current.aliasSync).connections[
                aliasConnectionKey({ version: 1, connectionId: current.connectionId })
              ]?.status === "removed";
            if (
              vendor === Vendor.simplelogin &&
              saveValues.token?.trim() &&
              (!current.token?.trim() ||
                !isSimpleLoginConnectionId(current.connectionId) ||
                removedConnection)
            ) {
              // Reconnecting is a new identity. The old carrier retains its terminal tombstone.
              saveValues.connectionId = createSimpleLoginConnectionId();
              saveValues.aliasSync = createAliasSyncDocument();
            }
            if (
              vendor === Vendor.simplelogin &&
              current.token?.trim() &&
              !saveValues.token?.trim() &&
              isSimpleLoginConnectionId(current.connectionId)
            ) {
              const settingsWithSync = attachSimpleLoginAliasSyncStore(
                current,
                settings,
                account,
                this.cipherService,
                this.syncService,
              );
              const lifecycle = createSimpleLoginAliasService({
                token: current.token,
                baseUrl: current.baseUrl,
                connectionId: current.connectionId,
                syncStore: simpleLoginAliasSyncStore(settingsWithSync),
              });
              saveValues.aliasSync = (await lifecycle.removeConnection()) ?? current.aliasSync;
            }
            if (
              !this.componentDestroyed &&
              this.account?.id === account.id &&
              this.forwarder === vendor
            ) {
              // The settings subject persists asynchronously. Keep it alive until storage emits.
              const saved = firstValueFrom(
                settings.pipe(
                  skip(1),
                  filter((stored) =>
                    Object.entries(saveValues).every(
                      ([key, value]) =>
                        JSON.stringify(stored[key as keyof ForwarderOptions]) ===
                        JSON.stringify(value),
                    ),
                  ),
                  takeUntil(cancelled$),
                ),
              );
              settings.next(saveValues);
              await saved;
            }
          } catch {
            // Do not terminate the save stream or expose provider responses and credentials.
            if (
              !this.componentDestroyed &&
              this.account?.id === account.id &&
              this.forwarder === vendor
            ) {
              this.toastService.showToast({
                variant: "error",
                title: "",
                message: this.i18nService.t("unexpectedError"),
              });
            }
          } finally {
            settings?.complete();
            account$.complete();
          }
        }),
        takeUntil(this.destroyed$),
      )
      .subscribe();
  }

  private saveSettings = new Subject<string>();
  save(site: string = "component api call") {
    this.saveSettings.next(site);
  }

  async ngOnChanges(changes: SimpleChanges) {
    this.refresh$.complete();
    if ("forwarder" in changes) {
      this.vendor.next(this.forwarder);
    }

    if ("account" in changes) {
      this.account$.next(this.account);
    }
  }

  protected displayDomain: boolean = false;
  protected displayToken: boolean = false;
  protected displayBaseUrl: boolean = false;
  protected displayPrefix: boolean = false;

  private readonly refresh$ = new Subject<void>();

  private readonly destroyed$ = new Subject<void>();
  private componentDestroyed = false;
  ngOnDestroy(): void {
    this.componentDestroyed = true;
    this.destroyed$.next();
    this.destroyed$.complete();
  }
}
