import { TestBed } from "@angular/core/testing";
import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject } from "rxjs";

import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { Account, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { Vendor } from "@bitwarden/common/tools/extension/vendor/data";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import {
  CredentialGeneratorService,
  ForwarderOptions,
  SimpleLoginAlias,
} from "@bitwarden/generator-core";

import { DesktopAliasService } from "./desktop-alias.service";

class MockRequest {
  readonly url: string;
  readonly headers: Headers;

  constructor(input: URL, init?: RequestInit) {
    this.url = input.toString();
    this.headers = init?.headers as Headers;
  }
}

describe("DesktopAliasService", () => {
  let apiService: MockProxy<ApiService>;
  let accountService: MockProxy<AccountService>;
  let cipherService: MockProxy<CipherService>;
  let generatorService: MockProxy<CredentialGeneratorService>;
  let settings: BehaviorSubject<ForwarderOptions>;
  let service: DesktopAliasService;

  const account = {
    id: "user-id" as UserId,
    email: "user@example.com",
    emailVerified: true,
    name: "User",
    creationDate: undefined,
  } satisfies Account;

  const alias = {
    id: 42,
    address: "alias@example.com",
  } as SimpleLoginAlias;

  const originalRequest = global.Request;

  beforeAll(() => {
    global.Request = MockRequest as any;
  });

  afterAll(() => {
    global.Request = originalRequest;
  });

  beforeEach(() => {
    apiService = mock<ApiService>();
    accountService = mock<AccountService>();
    Object.defineProperty(accountService, "activeAccount$", {
      value: new BehaviorSubject(account),
    });
    cipherService = mock<CipherService>();
    generatorService = mock<CredentialGeneratorService>();
    settings = new BehaviorSubject<ForwarderOptions>({
      token: "encrypted-setting-token",
      baseUrl: "https://simplelogin.example",
      domain: "",
      prefix: "",
    });
    generatorService.forwarder.mockReturnValue({} as any);
    generatorService.settings.mockReturnValue(settings as any);

    TestBed.configureTestingModule({
      providers: [
        DesktopAliasService,
        { provide: ApiService, useValue: apiService },
        { provide: AccountService, useValue: accountService },
        { provide: CipherService, useValue: cipherService },
        { provide: CredentialGeneratorService, useValue: generatorService },
      ],
    });

    service = TestBed.inject(DesktopAliasService);
  });

  it("uses the existing SimpleLogin forwarder settings", async () => {
    const client = await service.client();
    const response = mock<Response>({ status: 200, headers: new Headers() });
    response.text.mockResolvedValue(JSON.stringify([]));
    apiService.nativeFetch.mockResolvedValue(response);

    await client.domains();

    expect(generatorService.forwarder).toHaveBeenCalledWith(Vendor.simplelogin);
    const request = apiService.nativeFetch.mock.calls[0][0];
    expect(request.url).toBe("https://simplelogin.example/api/v2/setting/domains");
    expect(request.headers.get("Authentication")).toBe("encrypted-setting-token");
  });

  it("returns only logins with an exact stable alias binding", async () => {
    const bound = new CipherView();
    bound.id = "bound" as any;
    bound.name = "Bound login";
    bound.login = { username: "Alias@Example.com" } as any;
    bound.aliasBinding = {
      version: 1,
      provider: "simplelogin",
      id: "42",
      address: "alias@example.com",
    };

    const mismatched = new CipherView();
    mismatched.id = "mismatched" as any;
    mismatched.login = { username: "different@example.com" } as any;
    mismatched.aliasBinding = bound.aliasBinding;

    const deleted = new CipherView();
    deleted.id = "deleted" as any;
    deleted.deletedDate = new Date();
    deleted.login = { username: alias.address } as any;
    deleted.aliasBinding = bound.aliasBinding;

    cipherService.getAllDecrypted.mockResolvedValue([bound, mismatched, deleted]);

    await expect(service.boundLogins(alias)).resolves.toEqual([bound]);
    expect(cipherService.getAllDecrypted).toHaveBeenCalledWith(account.id);
  });

  it("releases decrypted forwarder settings when its route is destroyed", () => {
    const complete = jest.spyOn(settings, "complete");

    service.ngOnDestroy();

    expect(complete).toHaveBeenCalledTimes(1);
  });
});
