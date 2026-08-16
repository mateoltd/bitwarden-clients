/** @jest-environment node */

import { MockProxy, mock } from "jest-mock-extended";
import { BehaviorSubject, firstValueFrom } from "rxjs";

import { FakeAccountService, mockAccountServiceWith } from "@bitwarden/common/spec";
import { UserId } from "@bitwarden/common/types/guid";
import { CredentialGeneratorService, ForwarderOptions } from "@bitwarden/generator-core";

import { BrowserSimpleLoginAliasService } from "./browser-simple-login-alias.service";

describe("BrowserSimpleLoginAliasService", () => {
  const userId = "11111111-1111-4111-8111-111111111111" as UserId;
  const baseUrl = "https://app.simplelogin.io";
  const connectionId = "33333333-3333-4333-8333-333333333333";

  let generatorService: MockProxy<CredentialGeneratorService>;
  let accountService: FakeAccountService;
  let settings$: BehaviorSubject<ForwarderOptions>;
  let service: BrowserSimpleLoginAliasService;

  beforeEach(() => {
    generatorService = mock<CredentialGeneratorService>();
    accountService = mockAccountServiceWith(userId);
    settings$ = new BehaviorSubject<ForwarderOptions>({
      token: "provider-token-must-not-leak",
      baseUrl,
      connectionId,
    });
    generatorService.forwarder.mockReturnValue({} as any);
    generatorService.settings.mockReturnValue(settings$ as any);
    service = new BrowserSimpleLoginAliasService(accountService, generatorService);
  });

  it("requires the UUIDv4 persisted by explicit settings save without mutating settings", async () => {
    const next = jest.spyOn(settings$, "next");
    const client = await service["lifecycle"]();
    const identity = client.providerIdentity();

    expect(identity).toMatchObject({
      version: 1,
      connectionId,
      adapter: { adapterId: "simplelogin" },
    });
    expect(settings$.value.connectionId).toBe(identity.connectionId);
    expect(next).not.toHaveBeenCalled();
    expect(JSON.stringify(identity)).not.toContain(settings$.value.token);
  });

  it("rejects missing persisted identity instead of creating one during a read", async () => {
    const missing = { token: settings$.value.token, baseUrl };
    settings$ = new BehaviorSubject<ForwarderOptions>(missing);
    generatorService.settings.mockReturnValue(settings$ as any);
    const next = jest.spyOn(settings$, "next");

    await expect(service["lifecycle"]()).rejects.toMatchObject({ code: "invalid-credentials" });
    expect(settings$.value).toEqual(missing);
    expect(next).not.toHaveBeenCalled();
  });

  it("reads fresh encrypted settings after an account switch", async () => {
    const secondUserId = "22222222-2222-4222-8222-222222222222" as UserId;
    const firstId = "33333333-3333-4333-8333-333333333333";
    const secondId = "44444444-4444-4444-8444-444444444444";
    const secondSettings$ = new BehaviorSubject<ForwarderOptions>({
      token: "second-provider-token",
      baseUrl,
      connectionId: secondId,
    });
    settings$.next({ ...settings$.value, connectionId: firstId });
    generatorService.settings
      .mockReset()
      .mockReturnValueOnce(settings$ as any)
      .mockReturnValueOnce(secondSettings$ as any);

    expect((await service["lifecycle"]()).providerIdentity().connectionId).toBe(firstId);
    accountService.activeAccountSubject.next({
      id: secondUserId,
      name: "Second user",
      email: "second@example.com",
      emailVerified: true,
      creationDate: undefined,
    });
    expect((await service["lifecycle"]()).providerIdentity().connectionId).toBe(secondId);
    await expect(
      firstValueFrom(generatorService.settings.mock.calls[0][1]!.account$),
    ).resolves.toMatchObject({ id: userId });
    await expect(
      firstValueFrom(generatorService.settings.mock.calls[1][1]!.account$),
    ).resolves.toMatchObject({ id: secondUserId });
  });

  it("rejects malformed persisted identities instead of silently reconnecting", async () => {
    settings$.next({ ...settings$.value, connectionId: "invalid" });

    await expect(service["lifecycle"]()).rejects.toMatchObject({ code: "invalid-response" });
    expect(settings$.value.connectionId).toBe("invalid");
  });
});
