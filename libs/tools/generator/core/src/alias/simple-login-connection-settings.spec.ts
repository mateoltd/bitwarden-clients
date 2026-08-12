import { mock } from "jest-mock-extended";
import { BehaviorSubject } from "rxjs";

import { Account } from "@bitwarden/common/auth/abstractions/account.service";
import { UserId } from "@bitwarden/common/types/guid";

import { CredentialGeneratorService } from "../abstractions";
import { ForwarderOptions } from "../types";

import {
  createSimpleLoginConnectionId,
  isSimpleLoginConnectionId,
  readSimpleLoginAliasSettings,
} from "./simple-login-connection-settings";

const account = { id: "11111111-1111-4111-8111-111111111111" as UserId } as Account;

describe("SimpleLogin connection settings", () => {
  function reader(settings: ForwarderOptions) {
    const generatorService = mock<CredentialGeneratorService>();
    const subject = new BehaviorSubject(settings);
    generatorService.forwarder.mockReturnValue({} as any);
    generatorService.settings.mockReturnValue(subject as any);
    return { generatorService, subject, next: jest.spyOn(subject, "next") };
  }

  it("reads valid current settings without writing them", async () => {
    const current = {
      token: "provider-secret",
      baseUrl: "https://app.simplelogin.io",
      connectionId: "22222222-2222-4222-8222-222222222222",
    };
    const { generatorService, next } = reader(current);

    await expect(readSimpleLoginAliasSettings(generatorService, account)).resolves.toEqual(current);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects missing connection identities without writing settings", async () => {
    const { generatorService, next } = reader({ token: "provider-secret" });

    await expect(readSimpleLoginAliasSettings(generatorService, account)).rejects.toMatchObject({
      code: "invalid-credentials",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects invalid connection identities without writing settings", async () => {
    const { generatorService, next } = reader({
      token: "provider-secret",
      connectionId: "invalid",
    });

    await expect(readSimpleLoginAliasSettings(generatorService, account)).rejects.toMatchObject({
      code: "invalid-response",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("creates valid identities for configuration saves", () => {
    expect(isSimpleLoginConnectionId(createSimpleLoginConnectionId())).toBe(true);
  });
});
