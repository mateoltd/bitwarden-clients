import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { Router } from "@angular/router";
import { mock, MockProxy } from "jest-mock-extended";

import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { DialogService, ToastService } from "@bitwarden/components";
import {
  SimpleLoginAlias,
  SimpleLoginAliasService,
  SimpleLoginContact,
} from "@bitwarden/generator-core";

import { DesktopHeaderComponent } from "../../layout/header";

import { DesktopAliasComponent } from "./desktop-alias.component";
import { DesktopAliasService } from "./desktop-alias.service";

@Component({
  selector: "app-header",
  template: "<ng-content />",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class MockDesktopHeaderComponent {
  readonly title = input<string>();
  readonly icon = input<string>();
}

function makeAlias(overrides: Partial<SimpleLoginAlias> = {}): SimpleLoginAlias {
  return {
    id: 42,
    address: "desktop-alias@sl.test",
    name: "Desktop alias",
    note: "Created in test",
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
    ...overrides,
  };
}

describe("DesktopAliasComponent", () => {
  let fixture: ComponentFixture<DesktopAliasComponent>;
  let facade: MockProxy<DesktopAliasService>;
  let client: MockProxy<SimpleLoginAliasService>;
  let router: MockProxy<Router>;
  let dialogService: MockProxy<DialogService>;
  const alias = makeAlias();

  beforeEach(async () => {
    facade = mock<DesktopAliasService>();
    client = mock<SimpleLoginAliasService>();
    router = mock<Router>();
    dialogService = mock<DialogService>();
    facade.client.mockResolvedValue(client);
    facade.boundLogins.mockResolvedValue([]);
    client.list.mockResolvedValue({ items: [alias], page: 0 });
    client.domains.mockResolvedValue([{ domain: "sl.test", isCustom: false }]);
    client.get.mockResolvedValue(alias);
    client.contacts.mockResolvedValue({ items: [], page: 0 });

    const i18n = mock<I18nService>();
    i18n.t.mockImplementation((key: string) => key);

    await TestBed.configureTestingModule({
      imports: [DesktopAliasComponent],
      providers: [
        { provide: DesktopAliasService, useValue: facade },
        { provide: DialogService, useValue: dialogService },
        { provide: I18nService, useValue: i18n },
        { provide: Router, useValue: router },
        { provide: ToastService, useValue: mock<ToastService>() },
      ],
    })
      .overrideComponent(DesktopAliasComponent, {
        remove: { imports: [DesktopHeaderComponent] },
        add: { imports: [MockDesktopHeaderComponent] },
      })
      .compileComponents();

    fixture = TestBed.createComponent(DesktopAliasComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it("renders aliases and provider domains", () => {
    expect(fixture.nativeElement.textContent).toContain(alias.address);
    expect(fixture.nativeElement.textContent).toContain("sl.test");
    expect(client.list).toHaveBeenCalledWith(0, undefined, "all");
  });

  it("loads details, bound logins, and reverse aliases", async () => {
    const login = new CipherView();
    login.id = "cipher-id" as any;
    login.name = "Bound desktop login";
    const contact = {
      id: 7,
      address: "contact@example.com",
      reverseAliasAddress: "reverse@sl.test",
    } as SimpleLoginContact;
    facade.boundLogins.mockResolvedValue([login]);
    client.contacts.mockResolvedValue({ items: [contact], page: 0 });

    const aliasButton = fixture.debugElement
      .queryAll(By.css("button"))
      .find((button) => button.nativeElement.textContent.includes(alias.address));
    aliasButton!.nativeElement.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(client.get).toHaveBeenCalledWith(alias.id);
    expect(fixture.nativeElement.textContent).toContain("Bound desktop login");
    expect(fixture.nativeElement.textContent).toContain("reverse@sl.test");
  });

  it("creates a real lifecycle request and refreshes the list", async () => {
    const created = makeAlias({ id: 99, address: "created@sl.test" });
    client.create.mockResolvedValue(created);
    client.get.mockResolvedValue(created);

    const createButton = fixture.debugElement
      .queryAll(By.css("button"))
      .find((button) => button.nativeElement.textContent.includes("createRandomAlias"));
    createButton!.nativeElement.click();
    await fixture.whenStable();

    expect(client.create).toHaveBeenCalledWith({ kind: "random", hostname: undefined });
    expect(client.get).toHaveBeenCalledWith(created.id);
  });

  it("navigates to the vault to manage a bound login", async () => {
    const login = new CipherView();
    login.name = "Bound desktop login";

    await (fixture.componentInstance as any).manageLogin(login);

    expect(router.navigate).toHaveBeenCalledWith(["/vault"], {
      queryParams: { search: login.name },
    });
  });

  it("ignores a stale list response after a newer search finishes", async () => {
    let finishFirst!: (result: { items: SimpleLoginAlias[]; page: number }) => void;
    let finishSecond!: (result: { items: SimpleLoginAlias[]; page: number }) => void;
    client.list
      .mockReset()
      .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (finishSecond = resolve)));

    const first = (fixture.componentInstance as any).reload(0);
    await Promise.resolve();
    const second = (fixture.componentInstance as any).reload(1);
    await Promise.resolve();
    finishSecond({ items: [makeAlias({ id: 2 })], page: 1 });
    await second;
    finishFirst({ items: [makeAlias({ id: 1 })], page: 0 });
    await first;

    expect((fixture.componentInstance as any).page()).toBe(1);
    expect((fixture.componentInstance as any).aliases()[0].id).toBe(2);
  });
});
