import { FormBuilder } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { MockProxy, mock } from "jest-mock-extended";

import { SensitiveString } from "@bitwarden/alias-sdk-internal";
import { BrowserApi } from "@bitwarden/browser/platform/browser/browser-api";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { DialogService } from "@bitwarden/components";
import { SimpleLoginAlias, SimpleLoginContact } from "@bitwarden/generator-core";

import { BrowserSimpleLoginAliasService } from "../../alias/browser-simple-login-alias.service";

import { EmailAliasesComponent } from "./email-aliases.component";

describe("EmailAliasesComponent", () => {
  let aliasesService: MockProxy<BrowserSimpleLoginAliasService>;
  let dialogService: MockProxy<DialogService>;
  let router: MockProxy<Router>;
  let i18nService: MockProxy<I18nService>;

  beforeEach(() => {
    aliasesService = mock<BrowserSimpleLoginAliasService>();
    dialogService = mock<DialogService>();
    router = mock<Router>();
    i18nService = mock<I18nService>();
    i18nService.t.mockImplementation((key) => key);
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
    aliasesService.createReverseAlias.mockResolvedValue(contactFixture());
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

  it("requires confirmation before deleting a reverse alias", async () => {
    const alias = aliasFixture();
    const contact = contactFixture();
    aliasesService.get.mockResolvedValue(alias);
    aliasesService.contacts.mockResolvedValue({ items: [contact], page: 0 });
    dialogService.openSimpleDialog.mockResolvedValue(true);
    const component = createComponent("42");

    await component.ngOnInit();
    await component["deleteContact"](contact);

    expect(dialogService.openSimpleDialog).toHaveBeenCalledWith({
      title: { key: "delete" },
      content: { key: "deleteReverseAliasConfirmation" },
      acceptButtonText: { key: "delete" },
      type: "warning",
    });
    expect(aliasesService.deleteContact).toHaveBeenCalledWith(contact);
  });

  it("coalesces concurrent destructive actions", async () => {
    const alias = aliasFixture();
    const contact = contactFixture();
    let confirmDeletion!: (confirmed: boolean) => void;
    aliasesService.get.mockResolvedValue(alias);
    aliasesService.contacts.mockResolvedValue({ items: [contact], page: 0 });
    dialogService.openSimpleDialog.mockReturnValue(
      new Promise((resolve) => (confirmDeletion = resolve)),
    );
    const component = createComponent("42");
    await component.ngOnInit();

    const first = component["deleteContact"](contact);
    const duplicate = component["deleteContact"](contact);
    await Promise.resolve();

    expect(dialogService.openSimpleDialog).toHaveBeenCalledTimes(1);
    confirmDeletion(false);
    await Promise.all([first, duplicate]);
    expect(aliasesService.deleteContact).not.toHaveBeenCalled();
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
      i18nService,
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
    identity: {
      version: 1,
      connectionId: "11111111-1111-4111-8111-111111111111",
      aliasId: "42",
      address: "registration@sl.test" as SensitiveString,
    },
  };
}

function contactFixture(): SimpleLoginContact {
  return {
    id: 99,
    address: "contact@example.com",
    reverseAlias: "reply-token",
    reverseAliasAddress: "reply@sl.test",
    createdAt: 1,
    lastEmailSentAt: null,
    blocked: false,
    existed: false,
    identity: {
      alias: aliasFixture().identity,
      identityId: "99",
      recipient: "contact@example.com",
      address: "reply@sl.test",
      valid: true,
      blocked: false,
    } as never,
  };
}
