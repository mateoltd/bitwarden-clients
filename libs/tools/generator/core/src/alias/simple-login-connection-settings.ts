import { ReplaySubject, filter, firstValueFrom, skip } from "rxjs";

import { Account } from "@bitwarden/common/auth/abstractions/account.service";
import { Vendor } from "@bitwarden/common/tools/extension/vendor/data";
import { UserStateSubject } from "@bitwarden/common/tools/state/user-state-subject";

import { CredentialGeneratorService } from "../abstractions";
import { ForwarderOptions } from "../types";

import { SimpleLoginAliasError } from "./simple-login-alias.error";
import { SimpleLoginAliasSettings } from "./simple-login-alias.types";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pendingConnections = new Map<string, Promise<ForwarderOptions>>();

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

/** Persist a missing identity through the same encrypted subject that stores the provider token. */
export async function ensureSimpleLoginConnectionSettings(
  subject: UserStateSubject<ForwarderOptions>,
  current: ForwarderOptions,
  account: Account,
): Promise<ForwarderOptions> {
  if (!current.token?.trim()) {
    return current;
  }
  if (current.connectionId !== undefined) {
    if (!isSimpleLoginConnectionId(current.connectionId)) {
      throw new SimpleLoginAliasError(
        "SimpleLogin connection identity is invalid",
        "invalid-response",
      );
    }
    return current;
  }

  const key = account.id;
  const existing = pendingConnections.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const connectionId = createSimpleLoginConnectionId();
  const persisted = firstValueFrom(
    subject.pipe(
      skip(1),
      filter((settings): settings is ForwarderOptions => settings.connectionId === connectionId),
    ),
  );
  const migration = persisted.finally(() => pendingConnections.delete(key));
  pendingConnections.set(key, migration);
  subject.next({ ...current, connectionId });
  return migration;
}

/** Read and, when needed, durably migrate encrypted SimpleLogin connection settings. */
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
    const current = await firstValueFrom(settings$);
    const settings = await ensureSimpleLoginConnectionSettings(settings$, current, account);
    if (!settings.token?.trim() || !isSimpleLoginConnectionId(settings.connectionId)) {
      throw new SimpleLoginAliasError("SimpleLogin credentials are missing", "invalid-credentials");
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
