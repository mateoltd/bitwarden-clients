import { ReplaySubject, firstValueFrom } from "rxjs";

import { Account } from "@bitwarden/common/auth/abstractions/account.service";
import { Vendor } from "@bitwarden/common/tools/extension/vendor/data";

import { CredentialGeneratorService } from "../abstractions";
import { ForwarderOptions } from "../types";

import { SimpleLoginAliasError } from "./simple-login-alias.error";
import { SimpleLoginAliasSettings } from "./simple-login-alias.types";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isSimpleLoginConnectionId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

export function createSimpleLoginConnectionId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function readSimpleLoginAliasSettings(
  generatorService: CredentialGeneratorService,
  account: Account,
): Promise<SimpleLoginAliasSettings> {
  const account$ = new ReplaySubject<Account>(1);
  account$.next(account);
  const settings$ = generatorService.settings<ForwarderOptions>(
    generatorService.forwarder(Vendor.simplelogin),
    { account$ },
  );
  try {
    const settings = await firstValueFrom(settings$);
    if (!settings.token?.trim()) {
      throw new SimpleLoginAliasError("SimpleLogin credentials are missing", "invalid-credentials");
    }
    if (!isSimpleLoginConnectionId(settings.connectionId)) {
      throw new SimpleLoginAliasError(
        "SimpleLogin connection identity is invalid",
        settings.connectionId === undefined ? "invalid-credentials" : "invalid-response",
      );
    }
    return {
      token: settings.token,
      baseUrl: settings.baseUrl || undefined,
      connectionId: settings.connectionId,
    };
  } finally {
    account$.complete();
    settings$.complete();
  }
}
