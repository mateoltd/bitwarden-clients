import { Jsonify } from "type-fest";

import {
  GENERATOR_DISK,
  GENERATOR_MEMORY,
  UserKeyDefinition,
} from "@bitwarden/common/platform/state";
import { AliasSyncDocument, parseAliasSyncDocument } from "@bitwarden/common/tools/alias";
import { VendorId } from "@bitwarden/common/tools/extension";
import { Vendor } from "@bitwarden/common/tools/extension/vendor/data";
import { IntegrationContext, IntegrationId } from "@bitwarden/common/tools/integration";
import {
  ApiSettings,
  IntegrationRequest,
  SelfHostedApiSettings,
} from "@bitwarden/common/tools/integration/rpc";
import { PrivateClassifier } from "@bitwarden/common/tools/private-classifier";
import { PublicClassifier } from "@bitwarden/common/tools/public-classifier";
import { BufferedKeyDefinition } from "@bitwarden/common/tools/state/buffered-key-definition";
import { ObjectKey } from "@bitwarden/common/tools/state/object-key";

import { ForwarderConfiguration } from "../engine";
import { SelfHostedApiOptions } from "../types";

// integration types
export type SimpleLoginSettings = SelfHostedApiSettings & {
  connectionId?: string;
  aliasSync?: AliasSyncDocument;
};
export type SimpleLoginOptions = SelfHostedApiOptions;
export type SimpleLoginConfiguration = ForwarderConfiguration<SimpleLoginSettings>;

// default values
const defaultSettings = Object.freeze({
  token: "",
  domain: "",
  baseUrl: "",
  connectionId: undefined,
  aliasSync: undefined,
});

function deserializeSimpleLoginSettings(value: Jsonify<SimpleLoginSettings>): SimpleLoginSettings {
  const { aliasSync, ...settings } = value;
  return {
    ...settings,
    ...(aliasSync === undefined ? {} : { aliasSync: parseAliasSyncDocument(aliasSync) }),
  };
}

// forwarder configuration
const forwarder = Object.freeze({
  defaultSettings,
  request: ["token", "baseUrl"],
  settingsConstraints: {
    token: { required: true },
  },
  local: {
    settings: {
      // FIXME: integration should issue keys at runtime
      // based on integrationId & extension metadata
      // e.g. key: "forwarder.SimpleLogin.local.settings",
      key: "simpleLoginForwarder",
      target: "object",
      format: "secret-state",
      frame: 512,
      classifier: new PrivateClassifier<SimpleLoginSettings>(),
      state: GENERATOR_DISK,
      initial: defaultSettings,
      options: {
        deserializer: deserializeSimpleLoginSettings,
        clearOn: ["logout"],
      },
    } satisfies ObjectKey<SimpleLoginSettings>,
    import: {
      key: "forwarder.SimpleLogin.local.import",
      target: "object",
      format: "plain",
      classifier: new PublicClassifier<SimpleLoginSettings>(["token", "baseUrl"]),
      state: GENERATOR_MEMORY,
      options: {
        deserializer: deserializeSimpleLoginSettings,
        clearOn: ["logout", "lock"],
      },
    } satisfies ObjectKey<SimpleLoginSettings, Record<string, never>, SimpleLoginSettings>,
  },
  settings: new UserKeyDefinition<SimpleLoginSettings>(GENERATOR_DISK, "simpleLoginForwarder", {
    deserializer: deserializeSimpleLoginSettings,
    clearOn: [],
  }),
  importBuffer: new BufferedKeyDefinition<SimpleLoginSettings>(
    GENERATOR_DISK,
    "simpleLoginBuffer",
    {
      deserializer: deserializeSimpleLoginSettings,
      clearOn: ["logout"],
    },
  ),
} as const);

// integration-wide configuration
export const SimpleLogin = Object.freeze({
  id: Vendor.simplelogin as IntegrationId & VendorId,
  name: "SimpleLogin",
  selfHost: "maybe",
  extends: ["forwarder"],
  baseUrl: "https://app.simplelogin.io",
  authenticate(_request: IntegrationRequest, context: IntegrationContext<ApiSettings>) {
    return { Authentication: context.authenticationToken() };
  },
  forwarder,
} as SimpleLoginConfiguration);
