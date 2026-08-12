import { importProvidersFrom } from "@angular/core";
import { ActivatedRoute, RouterModule } from "@angular/router";
import {
  applicationConfig,
  componentWrapperDecorator,
  Meta,
  moduleMetadata,
  StoryObj,
} from "@storybook/angular";
import { BehaviorSubject, of } from "rxjs";

import {
  LoginEmailServiceAbstraction,
  LoginStrategyServiceAbstraction,
  LoginSuccessHandlerService,
} from "@bitwarden/auth/common";
import { InternalPolicyService } from "@bitwarden/common/admin-console/abstractions/policy/policy.service.abstraction";
import { DevicesApiServiceAbstraction } from "@bitwarden/common/auth/abstractions/devices-api.service.abstraction";
import { SsoLoginServiceAbstraction } from "@bitwarden/common/auth/abstractions/sso-login.service.abstraction";
import { PasswordPreloginService } from "@bitwarden/common/auth/password-prelogin";
import { ClientType } from "@bitwarden/common/enums";
import { AppIdService } from "@bitwarden/common/platform/abstractions/app-id.service";
import { BroadcasterService } from "@bitwarden/common/platform/abstractions/broadcaster.service";
import { ConfigService } from "@bitwarden/common/platform/abstractions/config/config.service";
import {
  Environment,
  EnvironmentService,
} from "@bitwarden/common/platform/abstractions/environment.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { MessagingService } from "@bitwarden/common/platform/abstractions/messaging.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { ValidationService } from "@bitwarden/common/platform/abstractions/validation.service";
import { PasswordStrengthServiceAbstraction } from "@bitwarden/common/tools/password-strength";
// This Storybook fixture follows the existing auth stories that compose component-library services.
// eslint-disable-next-line no-restricted-imports
import { AnonLayoutWrapperDataService, ToastService } from "@bitwarden/components";

import { LoginComponentService } from "./login-component.service";
import { LoginComponent } from "./login.component";

const environment = {
  getWebVaultUrl: () => "https://vault.bitwarden.test",
} as Environment;

const translations: Record<string, string> = {
  back: "Back",
  continue: "Continue",
  emailAddress: "Email address",
  hint: "Get master password hint",
  inputEmail: "Enter a valid email address.",
  inputMinLength: "Enter at least __$1__ characters.",
  inputRequired: "This field is required.",
  logIn: "Log in",
  loginWithDevice: "Log in with device",
  logInWithPasskey: "Log in with passkey",
  masterPass: "Master password",
  or: "or",
  rememberEmail: "Remember email",
  required: "required",
  useSingleSignOn: "Use single sign-on",
  yourOrganizationRequiresSingleSignOn: "Your organization requires single sign-on.",
};

const i18n = {
  t: (key: string, value?: string) => (translations[key] ?? key).replace("__$1__", value ?? ""),
  translate: (key: string, value?: string) =>
    (translations[key] ?? key).replace("__$1__", value ?? ""),
};

const decorators = [
  componentWrapperDecorator(
    (story) => /* html */ `
      <main class="tw-min-h-screen tw-bg-background tw-p-6 tw-text-main">
        <div class="tw-mx-auto tw-w-full tw-max-w-md">${story}</div>
      </main>
    `,
  ),
  moduleMetadata({
    providers: [
      { provide: ActivatedRoute, useValue: { queryParams: of({}) } },
      {
        provide: AnonLayoutWrapperDataService,
        useValue: { setAnonLayoutWrapperData: (): void => undefined },
      },
      { provide: AppIdService, useValue: { getAppId: async () => "storybook-device" } },
      { provide: BroadcasterService, useValue: { subscribe: (): void => undefined } },
      { provide: DevicesApiServiceAbstraction, useValue: { getKnownDevice: async () => false } },
      { provide: I18nService, useValue: i18n },
      {
        provide: LoginEmailServiceAbstraction,
        useValue: {
          rememberedEmail$: of(null),
          setLoginEmail: async (): Promise<void> => undefined,
          setRememberedEmailChoice: async (): Promise<void> => undefined,
          clearLoginEmail: async (): Promise<void> => undefined,
          clearRememberedEmail: async (): Promise<void> => undefined,
        },
      },
      {
        provide: LoginComponentService,
        useValue: {
          isLoginWithPasskeySupported: () => true,
          redirectToSsoLogin: async (): Promise<void> => undefined,
          redirectToSsoLoginWithOrganizationSsoIdentifier: async (): Promise<void> => undefined,
          showBackButton: (): void => undefined,
        },
      },
      {
        provide: LoginStrategyServiceAbstraction,
        useValue: { logIn: async (): Promise<void> => undefined },
      },
      { provide: MessagingService, useValue: { send: (): void => undefined } },
      { provide: PasswordStrengthServiceAbstraction, useValue: {} },
      { provide: PlatformUtilsService, useValue: { getClientType: () => ClientType.Web } },
      { provide: InternalPolicyService, useValue: {} },
      { provide: ToastService, useValue: { showToast: (): void => undefined } },
      { provide: LogService, useValue: { error: (): void => undefined } },
      { provide: ValidationService, useValue: { showError: (): void => undefined } },
      {
        provide: LoginSuccessHandlerService,
        useValue: { run: async (): Promise<void> => undefined },
      },
      { provide: ConfigService, useValue: { getFeatureFlag$: () => of(false) } },
      { provide: SsoLoginServiceAbstraction, useValue: { ssoRequiredCache$: of([]) } },
      {
        provide: EnvironmentService,
        useValue: {
          environment$: new BehaviorSubject(environment),
          globalEnvironment$: of(environment),
        },
      },
      { provide: PasswordPreloginService, useValue: { getPreloginData$: () => of({}) } },
    ],
  }),
  applicationConfig({
    providers: [importProvidersFrom(RouterModule.forRoot([]))],
  }),
];

export default {
  title: "Auth/Login",
  component: LoginComponent,
  decorators,
  parameters: { layout: "fullscreen" },
} as Meta<LoginComponent>;

type Story = StoryObj<LoginComponent>;

export const EmailEntry: Story = {};
