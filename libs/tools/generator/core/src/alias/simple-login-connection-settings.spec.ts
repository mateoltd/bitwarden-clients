import { BehaviorSubject } from "rxjs";

import { Account } from "@bitwarden/common/auth/abstractions/account.service";
import { UserStateSubject } from "@bitwarden/common/tools/state/user-state-subject";
import { UserId } from "@bitwarden/common/types/guid";

import { ForwarderOptions } from "../types";

import {
  ensureSimpleLoginConnectionSettings,
  isSimpleLoginConnectionId,
} from "./simple-login-connection-settings";

const account = { id: "11111111-1111-4111-8111-111111111111" as UserId } as Account;

describe("SimpleLogin encrypted connection settings", () => {
  it("migrates a configured account once and waits for the persisted echo", async () => {
    const behavior = new BehaviorSubject<ForwarderOptions>({
      token: "provider-secret",
      baseUrl: "https://app.simplelogin.io",
    });
    const subject = behavior as unknown as UserStateSubject<ForwarderOptions>;
    const next = jest.spyOn(subject, "next");

    const migrated = await ensureSimpleLoginConnectionSettings(subject, behavior.value, account);
    const restarted = await ensureSimpleLoginConnectionSettings(subject, migrated, account);

    expect(isSimpleLoginConnectionId(migrated.connectionId)).toBe(true);
    expect(restarted.connectionId).toBe(migrated.connectionId);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent first reads onto one durable identity", async () => {
    const current = { token: "provider-secret" };
    const behavior = new BehaviorSubject<ForwarderOptions>(current);
    const subject = behavior as unknown as UserStateSubject<ForwarderOptions>;
    const next = jest.spyOn(subject, "next");

    const [first, second] = await Promise.all([
      ensureSimpleLoginConnectionSettings(subject, current, account),
      ensureSimpleLoginConnectionSettings(subject, current, account),
    ]);

    expect(first.connectionId).toBe(second.connectionId);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not create identities for unconfigured accounts or replace malformed state", async () => {
    const empty = new BehaviorSubject<ForwarderOptions>(
      {},
    ) as unknown as UserStateSubject<ForwarderOptions>;
    await expect(ensureSimpleLoginConnectionSettings(empty, {}, account)).resolves.toEqual({});

    const invalid = { token: "provider-secret", connectionId: "invalid" };
    const behavior = new BehaviorSubject<ForwarderOptions>(invalid);
    const subject = behavior as unknown as UserStateSubject<ForwarderOptions>;
    await expect(
      ensureSimpleLoginConnectionSettings(subject, invalid, account),
    ).rejects.toMatchObject({
      code: "invalid-response",
    });
    expect(behavior.value).toEqual(invalid);
  });
});
