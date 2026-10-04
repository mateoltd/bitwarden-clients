import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";

import {
  createSimpleLoginAliasService,
  isSimpleLoginConnectionId,
  simpleLoginAliasSyncStore,
  toSimpleLoginCredentialMetadata,
} from "../alias";
import { Type } from "../metadata";
import {
  CredentialGenerator,
  ForwarderOptions,
  GeneratedCredential,
  GenerateRequest,
} from "../types";

import { ForwarderConfiguration } from "./forwarder-configuration";
import { ForwarderContext } from "./forwarder-context";

/** SimpleLogin generator engine using the same canonical lifecycle SDK as the alias clients. */
export class SimpleLoginForwarder implements CredentialGenerator<ForwarderOptions> {
  constructor(
    private readonly configuration: ForwarderConfiguration<ForwarderOptions>,
    private readonly i18n: I18nService,
    private readonly now: () => number,
  ) {}

  async generate(
    request: GenerateRequest,
    settings: ForwarderOptions,
  ): Promise<GeneratedCredential> {
    if (!settings.token?.trim() || !isSimpleLoginConnectionId(settings.connectionId)) {
      throw new Error(this.i18n.t("forwarderInvalidToken", this.configuration.name));
    }
    const context = new ForwarderContext(this.configuration, settings, this.i18n);
    const alias = await createSimpleLoginAliasService({
      token: settings.token,
      baseUrl: settings.baseUrl,
      connectionId: settings.connectionId,
      syncStore: simpleLoginAliasSyncStore(settings),
    }).create({
      hostname: request.website,
      note: context.generatedBy({ website: request.website }),
    });
    return new GeneratedCredential(
      alias.address,
      Type.email,
      this.now(),
      request.source,
      request.website,
      toSimpleLoginCredentialMetadata(alias),
    );
  }
}
