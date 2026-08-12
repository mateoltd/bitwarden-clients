import { importProvidersFrom } from "@angular/core";
import { ActivatedRoute, RouterModule } from "@angular/router";
import {
  applicationConfig,
  componentWrapperDecorator,
  Meta,
  moduleMetadata,
  StoryObj,
} from "@storybook/angular";
import { EMPTY, of } from "rxjs";

import { LogoutService } from "@bitwarden/auth/common";
import { InternalPolicyService } from "@bitwarden/common/admin-console/abstractions/policy/policy.service.abstraction";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { ClientType } from "@bitwarden/common/enums";
import { DeviceTrustServiceAbstraction } from "@bitwarden/common/key-management/device-trust/abstractions/device-trust.service.abstraction";
import { EncryptedMigrator } from "@bitwarden/common/key-management/encrypted-migrator/encrypted-migrator.abstraction";
import { InternalMasterPasswordServiceAbstraction } from "@bitwarden/common/key-management/master-password/abstractions/master-password.service.abstraction";
import { BroadcasterService } from "@bitwarden/common/platform/abstractions/broadcaster.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { MessagingService } from "@bitwarden/common/platform/abstractions/messaging.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import { PasswordStrengthServiceAbstraction } from "@bitwarden/common/tools/password-strength";
import { UserId } from "@bitwarden/common/types/guid";
import { AnonLayoutWrapperDataService, DialogService, ToastService } from "@bitwarden/components";
import {
  BiometricsService,
  BiometricsStatus,
  BiometricStateService,
  KeyService,
  UserAsymmetricKeysRegenerationService,
} from "@bitwarden/key-management";
import { CommandDefinition, MessageListener } from "@bitwarden/messaging";
import { UnlockService } from "@bitwarden/unlock";

import { LockComponentService, UnlockOptions } from "../services/lock-component.service";
import { WebAuthnPrfUnlockService } from "../services/webauthn-prf-unlock.service";

import { LockComponent } from "./lock.component";

const userId = "redesign-baseline-user" as UserId;
const account = {
  id: userId,
  email: "redesign@example.com",
  name: "Redesign Baseline",
  emailVerified: true,
};

const translations: Record<string, string> = {
  errorOccurred: "An error has occurred.",
  invalidMasterPassword: "The master password is incorrect.",
  logOut: "Log out",
  masterPass: "Master password",
  masterPasswordRequired: "Master password is required.",
  or: "or",
  required: "required",
  unlock: "Unlock",
  unlockWithMasterPassword: "Unlock with master password",
  unlockWithPasskey: "Unlock with passkey",
  unlockWithPin: "Unlock with PIN",
};

const i18n = {
  t: (key: string) => translations[key] ?? key,
  translate: (key: string) => translations[key] ?? key,
};

const unlockOptions: UnlockOptions = {
  masterPassword: { enabled: true },
  pin: { enabled: false },
  biometrics: {
    enabled: false,
    biometricsStatus: BiometricsStatus.PlatformUnsupported,
  },
  prf: { enabled: false },
};

export default {
  title: "Auth/Unlock",
  component: LockComponent,
  decorators: [
    componentWrapperDecorator(
      (story) => /* html */ `
        <main class="tw-min-h-screen tw-bg-background tw-p-6 tw-text-main">
          <div class="tw-mx-auto tw-w-full tw-max-w-md">${story}</div>
        </main>
      `,
    ),
    moduleMetadata({
      providers: [
        { provide: AccountService, useValue: { activeAccount$: of(account) } },
        {
          provide: KeyService,
          useValue: { hasUserKey: async () => false, userKey$: () => of(null) },
        },
        { provide: PlatformUtilsService, useValue: { getClientType: () => ClientType.Web } },
        { provide: DialogService, useValue: { openSimpleDialog: async () => false } },
        { provide: MessagingService, useValue: { send: (): void => undefined } },
        {
          provide: BiometricStateService,
          useValue: {
            promptAutomatically$: () => of(false),
            promptCancelled$: () => of(false),
            resetUserPromptCancelled: async (): Promise<void> => undefined,
          },
        },
        { provide: I18nService, useValue: i18n },
        { provide: InternalMasterPasswordServiceAbstraction, useValue: {} },
        {
          provide: LogService,
          useValue: { error: (): void => undefined, warning: (): void => undefined },
        },
        { provide: DeviceTrustServiceAbstraction, useValue: {} },
        { provide: SyncService, useValue: { fullSync: async () => true } },
        { provide: InternalPolicyService, useValue: {} },
        { provide: PasswordStrengthServiceAbstraction, useValue: {} },
        { provide: ToastService, useValue: { showToast: (): void => undefined } },
        { provide: UserAsymmetricKeysRegenerationService, useValue: {} },
        { provide: BiometricsService, useValue: {} },
        {
          provide: LogoutService,
          useValue: { logout: async (): Promise<void> => undefined },
        },
        {
          provide: LockComponentService,
          useValue: {
            getAvailableUnlockOptions$: () => of(unlockOptions),
            getExternalUnlock$: () => EMPTY,
            getBiometricsUnlockBtnText: () => "Unlock with biometrics",
            getPreviousUrl: (): null => null,
          },
        },
        {
          provide: AnonLayoutWrapperDataService,
          useValue: { setAnonLayoutWrapperData: (): void => undefined },
        },
        { provide: EncryptedMigrator, useValue: {} },
        { provide: BroadcasterService, useValue: {} },
        { provide: UnlockService, useValue: {} },
        {
          provide: WebAuthnPrfUnlockService,
          useValue: { isPrfUnlockAvailable: async () => false },
        },
        {
          provide: MessageListener,
          useValue: {
            messages$: (_command: CommandDefinition<Record<string, unknown>>) => EMPTY,
          },
        },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: (): null => null } } },
        },
      ],
    }),
    applicationConfig({
      providers: [importProvidersFrom(RouterModule.forRoot([]))],
    }),
  ],
  parameters: { layout: "fullscreen" },
} as Meta<LockComponent>;

type Story = StoryObj<LockComponent>;

export const MasterPassword: Story = {};
