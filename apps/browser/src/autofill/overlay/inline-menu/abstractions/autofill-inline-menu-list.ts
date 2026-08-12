import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";

import {
  InlineMenuCipherData,
  InlineMenuEmailAliasRecommendation,
} from "../../../background/abstractions/overlay.background";
import { InlineMenuFillType } from "../../../enums/autofill-overlay.enum";

type AutofillInlineMenuListMessage = { command: string };

export type UpdateAutofillInlineMenuListCiphersParams = {
  ciphers: InlineMenuCipherData[];
  showInlineMenuAccountCreation?: boolean;
};

export type UpdateAutofillInlineMenuListCiphersMessage = AutofillInlineMenuListMessage &
  UpdateAutofillInlineMenuListCiphersParams;

export type UpdateAutofillInlineMenuGeneratedPasswordMessage = AutofillInlineMenuListMessage & {
  generatedPassword: string;
};

export type UpdateAutofillInlineMenuEmailAliasMessage = AutofillInlineMenuListMessage & {
  emailAliasRecommendation?: InlineMenuEmailAliasRecommendation;
};

export type InitAutofillInlineMenuListMessage = AutofillInlineMenuListMessage & {
  authStatus: AuthenticationStatus;
  styleSheetUrl: string;
  theme: string;
  translations: Record<string, string>;
  ciphers?: InlineMenuCipherData[];
  inlineMenuFillType?: InlineMenuFillType;
  showInlineMenuAccountCreation?: boolean;
  showPasskeysLabels?: boolean;
  portKey: string;
  token: string;
  generatedPassword?: string;
  emailAliasRecommendation?: InlineMenuEmailAliasRecommendation;
  showSaveLoginMenu?: boolean;
  showAnimations?: boolean;
};

export type AutofillInlineMenuListWindowMessageHandlers = {
  [key: string]: CallableFunction;
  initAutofillInlineMenuList: ({ message }: { message: InitAutofillInlineMenuListMessage }) => void;
  checkAutofillInlineMenuListFocused: () => void;
  updateAutofillInlineMenuListCiphers: ({
    message,
  }: {
    message: UpdateAutofillInlineMenuListCiphersMessage;
  }) => void;
  updateAutofillInlineMenuGeneratedPassword: ({
    message,
  }: {
    message: UpdateAutofillInlineMenuGeneratedPasswordMessage;
  }) => void;
  updateAutofillInlineMenuEmailAliasRecommendation: ({
    message,
  }: {
    message: UpdateAutofillInlineMenuEmailAliasMessage;
  }) => void;
  focusAutofillInlineMenuList: () => void;
};
