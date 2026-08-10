/** @jest-environment node */

import { MockProxy, mock } from "jest-mock-extended";
import { BehaviorSubject, firstValueFrom } from "rxjs";

import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { FakeAccountService, mockAccountServiceWith } from "@bitwarden/common/spec";
import { UserId } from "@bitwarden/common/types/guid";
import { CredentialGeneratorService, ForwarderOptions } from "@bitwarden/generator-core";

import { BrowserSimpleLoginAliasService } from "./browser-simple-login-alias.service";

describe("BrowserSimpleLoginAliasService", () => {
  const userId = "browser-alias-user" as UserId;
  const token = "provider-token-must-not-leak";
  const baseUrl = "https://simplelogin.test";

  let apiService: MockProxy<ApiService>;
  let generatorService: MockProxy<CredentialGeneratorService>;
  let accountService: FakeAccountService;
  let settings$: BehaviorSubject<ForwarderOptions>;
  let service: BrowserSimpleLoginAliasService;

  beforeEach(() => {
    apiService = mock<ApiService>();
    generatorService = mock<CredentialGeneratorService>();
    accountService = mockAccountServiceWith(userId);
    settings$ = new BehaviorSubject<ForwarderOptions>({ token, baseUrl });
    generatorService.forwarder.mockReturnValue({} as any);
    generatorService.settings.mockReturnValue(settings$ as any);

    service = new BrowserSimpleLoginAliasService(apiService, accountService, generatorService);
  });

  it("reuses the hostname recommendation and returns only public binding metadata", async () => {
    const complete = jest.spyOn(settings$, "complete");
    apiService.nativeFetch
      .mockResolvedValueOnce(
        jsonResponse({
          can_create: true,
          prefix_suggestion: "example",
          suffixes: [],
          recommendation: { alias: "existing@sl.test" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ aliases: [aliasJson(42, "existing@sl.test")] }));

    const result = await service.recommendOrCreate("https://www.example.com/register");

    expect(result.credential).toBe("existing@sl.test");
    expect(result.website).toBe("https://www.example.com/register");
    expect(result.metadata).toEqual({
      kind: "email-alias",
      alias: {
        version: 1,
        provider: "simplelogin",
        id: "42",
        address: "existing@sl.test",
      },
    });
    expect(JSON.stringify(result.metadata)).not.toContain(token);
    expect(apiService.nativeFetch).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("creates an alias with the registration hostname when no reusable alias exists", async () => {
    apiService.nativeFetch
      .mockResolvedValueOnce(
        jsonResponse({
          can_create: true,
          prefix_suggestion: "signup",
          suffixes: [],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(aliasJson(84, "created@sl.test"), 201));

    const result = await service.recommendOrCreate("https://signup.example.net/new");

    expect(result.metadata?.alias.id).toBe("84");
    const createRequest = apiService.nativeFetch.mock.calls[1][0] as Request;
    expect(createRequest.url).toContain("hostname=signup.example.net");
    expect(await createRequest.clone().json()).toEqual({
      note: "Bitwarden: signup.example.net",
    });
    expect(createRequest.headers.get("Authentication")).toBe(token);
    expect(result.toJSON()).not.toHaveProperty("metadata");
  });

  it("reads fresh account-scoped settings after an account switch", async () => {
    const secondUserId = "second-browser-alias-user" as UserId;
    const secondSettings$ = new BehaviorSubject<ForwarderOptions>({
      token: "second-provider-token",
      baseUrl,
    });
    generatorService.settings
      .mockReset()
      .mockReturnValueOnce(settings$ as any)
      .mockReturnValueOnce(secondSettings$ as any);
    apiService.nativeFetch
      .mockResolvedValueOnce(jsonResponse(aliasJson(1, "first@sl.test"), 201))
      .mockResolvedValueOnce(jsonResponse(aliasJson(2, "second@sl.test"), 201));

    await service.create();
    accountService.activeAccountSubject.next({
      id: secondUserId,
      name: "Second user",
      email: "second@example.com",
      emailVerified: true,
      creationDate: undefined,
    });
    await service.create();

    expect((apiService.nativeFetch.mock.calls[0][0] as Request).headers.get("Authentication")).toBe(
      token,
    );
    expect((apiService.nativeFetch.mock.calls[1][0] as Request).headers.get("Authentication")).toBe(
      "second-provider-token",
    );
    await expect(
      firstValueFrom(generatorService.settings.mock.calls[0][1]!.account$),
    ).resolves.toMatchObject({ id: userId });
    await expect(
      firstValueFrom(generatorService.settings.mock.calls[1][1]!.account$),
    ).resolves.toMatchObject({ id: secondUserId });
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function aliasJson(id: number, email: string): Record<string, unknown> {
  return {
    id,
    email,
    name: null,
    note: null,
    enabled: true,
    pinned: false,
    creation_timestamp: 1_700_000_000,
    nb_block: 0,
    nb_forward: 0,
    nb_reply: 0,
    support_pgp: false,
    disable_pgp: false,
    mailboxes: [],
    latest_activity: null,
  };
}
