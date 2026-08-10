import { FormBuilder } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { MockProxy, mock } from "jest-mock-extended";

import { BrowserApi } from "@bitwarden/browser/platform/browser/browser-api";
import { DialogService } from "@bitwarden/components";
import { SimpleLoginAlias } from "@bitwarden/generator-core";

import { BrowserSimpleLoginAliasService } from "../../alias/browser-simple-login-alias.service";

import { EmailAliasesComponent } from "./email-aliases.component";

describe("EmailAliasesComponent", () => {
  let aliasesService: MockProxy<BrowserSimpleLoginAliasService>;
  let dialogService: MockProxy<DialogService>;
  let router: MockProxy<Router>;

  beforeEach(() => {
    aliasesService = mock<BrowserSimpleLoginAliasService>();
    dialogService = mock<DialogService>();
    router = mock<Router>();
    jest.spyOn(BrowserApi, "getTabFromCurrentWindowId").mockResolvedValue({
      id: 1,
      url: "https://signup.example.com/register",
    } as chrome.tabs.Tab);
  });

  afterEach(() => jest.restoreAllMocks());

  it("loads searchable aliases, domains, pagination, and a hostname recommendation", async () => {
    const alias = aliasFixture();
    aliasesService.list.mockResolvedValue({ items: [alias], page: 0, nextPage: 1 });
    aliasesService.domains.mockResolvedValue([{ domain: "sl.test", isCustom: false }]);
    aliasesService.recommend.mockResolvedValue({
      hostname: "signup.example.com",
      canCreate: true,
      prefixSuggestion: "signup",
      suffixes: [],
      alias,
    });
    const component = createComponent();

    await component.ngOnInit();

    expect(component["aliases"]()).toEqual([alias]);
    expect(component["domainNames"]).toBe("sl.test");
    expect(component["nextPage"]()).toBe(1);
    expect(aliasesService.recommend).toHaveBeenCalledWith("https://signup.example.com/register");
  });

  it("performs detail lifecycle and reverse-alias actions", async () => {
    const alias = aliasFixture();
    aliasesService.get.mockResolvedValue(alias);
    aliasesService.contacts.mockResolvedValue({ items: [], page: 0 });
    aliasesService.update.mockResolvedValue({ ...alias, note: "updated" });
    aliasesService.setEnabled.mockResolvedValue({ ...alias, enabled: false });
    aliasesService.createReverseAlias.mockResolvedValue({
      id: 99,
      address: "contact@example.com",
      reverseAlias: "reply-token",
      reverseAliasAddress: "reply@sl.test",
      createdAt: 1,
      lastEmailSentAt: null,
      blocked: false,
      existed: false,
    });
    const component = createComponent("42");

    await component.ngOnInit();
    component["editForm"].setValue({ name: "Registration", note: "updated" });
    await component["save"]();
    await component["toggleEnabled"]();
    component["reverseAliasForm"].setValue({ contact: "contact@example.com" });
    await component["createReverseAlias"]();

    expect(aliasesService.update).toHaveBeenCalledWith(42, {
      name: "Registration",
      note: "updated",
    });
    expect(aliasesService.setEnabled).toHaveBeenCalledWith(42, false);
    expect(aliasesService.createReverseAlias).toHaveBeenCalledWith(42, "contact@example.com");
  });

  function createComponent(id: string | null = null) {
    const route = {
      snapshot: { paramMap: { get: jest.fn().mockReturnValue(id) } },
    } as unknown as ActivatedRoute;
    return new EmailAliasesComponent(
      aliasesService,
      dialogService,
      new FormBuilder(),
      route,
      router,
    );
  }
});

function aliasFixture(): SimpleLoginAlias {
  return {
    id: 42,
    address: "registration@sl.test",
    name: "Registration",
    note: null,
    enabled: true,
    pinned: false,
    createdAt: 1,
    blockedCount: 0,
    forwardedCount: 0,
    repliedCount: 0,
    supportsPgp: false,
    pgpDisabled: false,
    mailboxes: [],
    latestActivity: null,
  };
}
