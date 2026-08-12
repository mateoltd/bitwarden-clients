import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { ActivatedRoute, provideRouter, Router } from "@angular/router";
import { mock, MockProxy } from "jest-mock-extended";

import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { DialogService } from "@bitwarden/components";
import {
  SimpleLoginAlias,
  SimpleLoginAliasRecommendation,
  SimpleLoginContact,
} from "@bitwarden/generator-core";

import { HeaderModule } from "../../layouts/header/header.module";

import { EmailAliasesComponent } from "./email-aliases.component";
import { WebSimpleLoginAliasService } from "./web-simple-login-alias.service";

@Component({
  selector: "app-header",
  template: "",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class MockHeaderComponent {}

function alias(id = 7, address = "alias@sl.example"): SimpleLoginAlias {
  return {
    id,
    address,
    name: "Alias",
    note: "Created in web",
    enabled: true,
    pinned: false,
    createdAt: 1,
    blockedCount: 0,
    forwardedCount: 0,
    repliedCount: 0,
    supportsPgp: true,
    pgpDisabled: false,
    mailboxes: [{ id: 3, email: "mailbox@example.com" }],
    latestActivity: null,
  };
}

const contact: SimpleLoginContact = {
  id: 11,
  address: "contact@example.com",
  reverseAlias: "reverse-token",
  reverseAliasAddress: "reverse@sl.example",
  createdAt: 1,
  lastEmailSentAt: null,
  blocked: false,
  existed: false,
};

describe("EmailAliasesComponent", () => {
  let aliasesService: MockProxy<WebSimpleLoginAliasService>;
  let dialogService: MockProxy<DialogService>;
  let router: MockProxy<Router>;
  let component: EmailAliasesComponent;

  beforeEach(() => {
    aliasesService = mock<WebSimpleLoginAliasService>();
    dialogService = mock<DialogService>();
    router = mock<Router>();
    router.navigate.mockResolvedValue(true);

    aliasesService.isConfigured.mockResolvedValue(true);
    aliasesService.list.mockResolvedValue({ items: [alias()], page: 0, nextPage: 1 });
    aliasesService.domains.mockResolvedValue([
      { domain: "sl.example", isCustom: false },
      { domain: "custom.example", isCustom: true },
    ]);
    aliasesService.get.mockResolvedValue(alias());
    aliasesService.contacts.mockResolvedValue({ items: [contact], page: 0 });

    component = new EmailAliasesComponent(
      aliasesService,
      dialogService,
      { t: (key: string) => key } as I18nService,
      {
        snapshot: { queryParamMap: { get: () => null } },
      } as unknown as ActivatedRoute,
      router,
    );
  });

  it("loads aliases, pagination, and domains from encrypted SimpleLogin configuration", async () => {
    await component.ngOnInit();

    expect(component.configured).toBe(true);
    expect(component.aliases).toEqual([alias()]);
    expect(component.nextPage).toBe(1);
    expect(component.domains).toHaveLength(2);
    expect(aliasesService.list).toHaveBeenCalledWith(0, "", "all");
  });

  it("recommends reuse and creates then opens a real lifecycle alias", async () => {
    const recommendation: SimpleLoginAliasRecommendation = {
      hostname: "example.com",
      canCreate: true,
      prefixSuggestion: "example",
      suffixes: [],
      alias: alias(),
    };
    aliasesService.recommend.mockResolvedValue(recommendation);
    aliasesService.create.mockResolvedValue(alias(8, "created@sl.example"));
    aliasesService.get.mockResolvedValue(alias(8, "created@sl.example"));
    component.website = "https://example.com/register";

    await component.recommend();
    expect(component.recommendation).toEqual(recommendation);

    await component.createAlias();

    expect(aliasesService.create).toHaveBeenCalledWith({
      kind: "random",
      hostname: "https://example.com/register",
    });
    expect(component.selected?.id).toBe(8);
    expect(router.navigate).toHaveBeenCalledWith([], {
      relativeTo: expect.anything(),
      queryParams: { aliasId: 8 },
      queryParamsHandling: "merge",
      replaceUrl: true,
    });
  });

  it("updates, disables, and deletes the selected alias", async () => {
    component.selected = alias();
    component.recommendation = {
      hostname: "example.com",
      canCreate: true,
      prefixSuggestion: "example",
      suffixes: [],
      alias: component.selected,
    };
    aliasesService.update.mockResolvedValue({ ...alias(), name: "Updated" });
    aliasesService.setEnabled.mockResolvedValue({ ...alias(), enabled: false });
    dialogService.openSimpleDialog.mockResolvedValue(true);

    await component.saveAlias();
    expect(aliasesService.update).toHaveBeenCalledWith(7, {
      name: "Alias",
      note: "Created in web",
      pinned: false,
      pgpDisabled: false,
      mailboxIds: [3],
    });

    await component.setEnabled(false);
    expect(component.selected?.enabled).toBe(false);

    await component.deleteAlias();
    expect(aliasesService.delete).toHaveBeenCalledWith(7);
    expect(component.selected).toBeUndefined();
    expect(component.recommendation).toBeUndefined();
  });

  it("creates, blocks, paginates, and deletes reverse aliases", async () => {
    component.selected = alias();
    component.reverseAliasContact = " contact@example.com ";
    aliasesService.createReverseAlias.mockResolvedValue(contact);
    aliasesService.toggleContactBlocked.mockResolvedValue(true);
    dialogService.openSimpleDialog.mockResolvedValue(true);

    await component.createReverseAlias();
    expect(aliasesService.createReverseAlias).toHaveBeenCalledWith(7, "contact@example.com");
    expect(component.contacts).toEqual([contact]);

    await component.toggleContact(contact);
    expect(contact.blocked).toBe(true);

    await component.removeContact(contact);
    expect(aliasesService.deleteContact).toHaveBeenCalledWith(11);
  });

  it("does not call the provider when SimpleLogin is not configured", async () => {
    aliasesService.isConfigured.mockResolvedValue(false);

    await component.ngOnInit();

    expect(component.configured).toBe(false);
    expect(aliasesService.list).not.toHaveBeenCalled();
    expect(aliasesService.domains).not.toHaveBeenCalled();
  });

  it("sends only one provider request for concurrent create actions", async () => {
    let finishCreate!: (created: SimpleLoginAlias) => void;
    aliasesService.create.mockReturnValue(new Promise((resolve) => (finishCreate = resolve)));

    const first = component.createAlias();
    const duplicate = component.createAlias();
    await Promise.resolve();

    expect(aliasesService.create).toHaveBeenCalledTimes(1);
    finishCreate(alias(8, "created@sl.example"));
    await Promise.all([first, duplicate]);
  });

  describe("rendered page", () => {
    let fixture: ComponentFixture<EmailAliasesComponent>;

    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [EmailAliasesComponent, NoopAnimationsModule],
        providers: [
          provideRouter([]),
          { provide: WebSimpleLoginAliasService, useValue: aliasesService },
          { provide: DialogService, useValue: dialogService },
          { provide: I18nService, useValue: { t: (key: string) => key } },
          { provide: PlatformUtilsService, useValue: mock<PlatformUtilsService>() },
        ],
      })
        .overrideComponent(EmailAliasesComponent, {
          remove: { imports: [HeaderModule] },
          add: { imports: [MockHeaderComponent] },
        })
        .compileComponents();

      fixture = TestBed.createComponent(EmailAliasesComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    });

    it("renders provider-backed aliases, domains, and lifecycle controls", () => {
      const text = fixture.nativeElement.textContent;
      expect(text).toContain("alias@sl.example");
      expect(text).toContain("sl.example");
      expect(text).toContain("createEmailAlias");
      expect(fixture.nativeElement.querySelector("[data-testid='alias-list']")).not.toBeNull();
    });
  });
});
