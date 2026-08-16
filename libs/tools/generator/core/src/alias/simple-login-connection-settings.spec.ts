import { mock } from "jest-mock-extended";
import { BehaviorSubject } from "rxjs";

import { Account } from "@bitwarden/common/auth/abstractions/account.service";
import { appendAliasSyncEvent, createAliasSyncDocument } from "@bitwarden/common/tools/alias";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { createAliasConnectionCipher } from "@bitwarden/common/vault/alias-connection";

import { CredentialGeneratorService } from "../abstractions";
import { ForwarderOptions } from "../types";

import {
  createSimpleLoginConnectionId,
  isSimpleLoginConnectionId,
  readSimpleLoginAliasSettings,
} from "./simple-login-connection-settings";

describe("SimpleLogin schema-v1 connection identity", () => {
  function reader(settings: ForwarderOptions) {
    const generatorService = mock<CredentialGeneratorService>();
    const subject = new BehaviorSubject(settings);
    generatorService.forwarder.mockReturnValue({} as never);
    generatorService.settings.mockReturnValue(subject as never);
    return { generatorService, subject, next: jest.spyOn(subject, "next") };
  }

  it("creates a valid UUIDv4 only for explicit settings-save callers", () => {
    const connectionId = createSimpleLoginConnectionId();

    expect(isSimpleLoginConnectionId(connectionId)).toBe(true);
  });

  it.each([undefined, null, "", "invalid", "11111111-1111-1111-8111-111111111111"])(
    "rejects a missing or malformed persisted identity: %p",
    (connectionId) => {
      expect(isSimpleLoginConnectionId(connectionId)).toBe(false);
    },
  );

  it("reads valid persisted settings without writing them", async () => {
    const current = {
      token: "provider-secret",
      baseUrl: "https://app.simplelogin.io",
      connectionId: "22222222-2222-4222-8222-222222222222",
    };
    const { generatorService, next } = reader(current);

    await expect(
      readSimpleLoginAliasSettings(generatorService, {
        id: "11111111-1111-4111-8111-111111111111" as UserId,
      } as Account),
    ).resolves.toMatchObject(current);
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "invalid-credentials"],
    ["invalid", "invalid-response"],
  ])("rejects persisted identity %p without writing settings", async (connectionId, code) => {
    const { generatorService, next } = reader({ token: "provider-secret", connectionId });

    await expect(
      readSimpleLoginAliasSettings(generatorService, {
        id: "11111111-1111-4111-8111-111111111111" as UserId,
      } as Account),
    ).rejects.toMatchObject({ code });
    expect(next).not.toHaveBeenCalled();
  });

  it("recovers an encrypted schema-v1 carrier for the session without mutating settings", async () => {
    const userId = "11111111-1111-4111-8111-111111111111" as UserId;
    const account = { id: userId } as Account;
    const connection = {
      version: 1 as const,
      connectionId: "22222222-2222-4222-8222-222222222222",
    };
    let sync = createAliasSyncDocument("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    sync = appendAliasSyncEvent(sync, { kind: "connection-upsert", connection });
    const carrier = createAliasConnectionCipher({
      version: 1,
      connection,
      credential: { token: "encrypted-provider-token", baseUrl: "https://app.simplelogin.io/" },
      sync,
    });
    const settings = new BehaviorSubject<ForwarderOptions>({
      connectionId: connection.connectionId,
    });
    const next = jest.spyOn(settings, "next");
    const generator = mock<CredentialGeneratorService>();
    generator.forwarder.mockReturnValue({} as never);
    generator.settings.mockReturnValue(settings as never);
    const cipherService = mock<CipherService>();
    cipherService.getAllDecryptedIncludingInternal.mockResolvedValue([carrier]);

    const recovered = await readSimpleLoginAliasSettings(generator, account, cipherService);

    expect(recovered).toMatchObject({
      token: "encrypted-provider-token",
      baseUrl: "https://app.simplelogin.io/",
      connectionId: connection.connectionId,
    });
    expect(settings.value).toEqual({ connectionId: connection.connectionId });
    expect(next).not.toHaveBeenCalled();
  });
});
