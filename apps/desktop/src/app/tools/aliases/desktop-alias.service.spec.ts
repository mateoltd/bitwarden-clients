import { TestBed } from "@angular/core/testing";
import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject } from "rxjs";

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

describe("DesktopAliasService", () => {
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

  const alias = mock<SimpleLoginAlias>({
    id: 42,
    address: "alias@example.com",
    identity: {
      version: 1,
      connectionId: "11111111-1111-4111-8111-111111111111",
      aliasId: "42",
      address: "alias@example.com",
    },
  });

  beforeEach(() => {
    accountService = mock<AccountService>();
    Object.defineProperty(accountService, "activeAccount$", {
      value: new BehaviorSubject(account),
    });
    cipherService = mock<CipherService>();
    generatorService = mock<CredentialGeneratorService>();
    settings = new BehaviorSubject<ForwarderOptions>({
      token: "encrypted-setting-token",
      baseUrl: "https://simplelogin.example",
      connectionId: "11111111-1111-4111-8111-111111111111",
      domain: "",
      prefix: "",
    });
    generatorService.forwarder.mockReturnValue({} as any);
    generatorService.settings.mockReturnValue(settings as any);

    TestBed.configureTestingModule({
      providers: [
        DesktopAliasService,
        { provide: AccountService, useValue: accountService },
        { provide: CipherService, useValue: cipherService },
        { provide: CredentialGeneratorService, useValue: generatorService },
      ],
    });

    service = TestBed.inject(DesktopAliasService);
  });

  it("uses the existing SimpleLogin forwarder settings", async () => {
    const client = await service.client();

    expect(generatorService.forwarder).toHaveBeenCalledWith(Vendor.simplelogin);
    expect(client.providerIdentity()).toMatchObject({
      version: 1,
      connectionId: "11111111-1111-4111-8111-111111111111",
      adapter: { adapterId: "simplelogin" },
    });
  });

  it("returns only logins with an exact stable alias binding", async () => {
    const bound = new CipherView();
    bound.id = "bound" as any;
    bound.name = "Bound login";
    bound.login = { username: "Alias@Example.com" } as any;
    bound.aliasBinding = {
      version: 1,
      connectionId: "11111111-1111-4111-8111-111111111111",
      aliasId: "42",
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

    const otherInstance = new CipherView();
    otherInstance.id = "other-instance" as any;
    otherInstance.login = { username: alias.address } as any;
    otherInstance.aliasBinding = {
      ...bound.aliasBinding,
      aliasId: "opaque-other-id",
    };

    const otherConnection = new CipherView();
    otherConnection.id = "other-connection" as any;
    otherConnection.login = { username: alias.address } as any;
    otherConnection.aliasBinding = {
      ...bound.aliasBinding,
      connectionId: "22222222-2222-4222-8222-222222222222",
    };

    cipherService.getAllDecrypted.mockResolvedValue([
      bound,
      mismatched,
      deleted,
      otherInstance,
      otherConnection,
    ]);

    await expect(service.boundLogins(alias)).resolves.toEqual([bound]);
    expect(cipherService.getAllDecrypted).toHaveBeenCalledWith(account.id);
  });

  it("releases decrypted forwarder settings immediately after creating a request client", async () => {
    const complete = jest.spyOn(settings, "complete");

    await service.client();

    expect(complete).toHaveBeenCalledTimes(1);
  });
});
