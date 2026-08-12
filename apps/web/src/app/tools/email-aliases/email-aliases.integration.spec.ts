import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { provideRouter } from "@angular/router";
import { mock } from "jest-mock-extended";
import nodeFetch, {
  Headers as NodeHeaders,
  Request as NodeRequest,
  Response as NodeResponse,
} from "node-fetch";
import { BehaviorSubject, of } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { DialogService } from "@bitwarden/components";
import {
  CredentialGeneratorService,
  createSimpleLoginAliasService,
  SimpleLoginAliasService,
  SimpleLoginContact,
} from "@bitwarden/generator-core";

import { HeaderModule } from "../../layouts/header/header.module";

import { EmailAliasesComponent } from "./email-aliases.component";
import { WebSimpleLoginAliasService } from "./web-simple-login-alias.service";

const integrationEnabled =
  process.env["SIMPLELOGIN_INTEGRATION"] === "1" &&
  process.env["BITWARDEN_SERVER_INTEGRATION"] === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;

@Component({
  selector: "app-header",
  template: "",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class MockHeaderComponent {}

describeIntegration("rendered web email alias experience against real services", () => {
  jest.setTimeout(120_000);

  const simpleLoginBaseUrl = process.env["SIMPLELOGIN_BASE_URL"] ?? "http://127.0.0.1:7777";
  const simpleLoginEmail = process.env["SIMPLELOGIN_EMAIL"] ?? "john@wick.com";
  const simpleLoginPassword = process.env["SIMPLELOGIN_PASSWORD"] ?? "password";
  const bitwardenApiUrl = process.env["BITWARDEN_API_URL"] ?? "http://localhost:4000";
  const aliasesToDelete = new Set<number>();
  const contactsToDelete = new Set<number>();
  let lifecycle: SimpleLoginAliasService;
  let facade: WebSimpleLoginAliasService;

  beforeAll(async () => {
    const connectionId = "11111111-1111-4111-8111-111111111111";
    Object.assign(globalThis, {
      fetch: nodeFetch,
      Headers: NodeHeaders,
      Request: NodeRequest,
      Response: NodeResponse,
    });

    const bitwardenHealth = await nodeFetch(`${bitwardenApiUrl}/alive`);
    expect(bitwardenHealth.ok).toBe(true);

    const login = await nodeFetch(`${simpleLoginBaseUrl}/api/auth/login`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        email: simpleLoginEmail,
        password: simpleLoginPassword,
        device: "Bitwarden web alias rendered integration test",
      }),
    });
    const body = (await login.json()) as { api_key?: unknown };
    if (!login.ok || typeof body.api_key !== "string") {
      throw new Error(`SimpleLogin test login failed (${login.status})`);
    }

    lifecycle = createSimpleLoginAliasService({
      token: body.api_key,
      baseUrl: simpleLoginBaseUrl,
      connectionId,
    });
    facade = new WebSimpleLoginAliasService(
      { activeAccount$: of({ id: "web-alias-integration" }) } as AccountService,
      {
        forwarder: () => ({ id: "simplelogin" }),
        settings: () =>
          new BehaviorSubject({ token: body.api_key, baseUrl: simpleLoginBaseUrl, connectionId }),
      } as unknown as CredentialGeneratorService,
    );
  });

  afterAll(async () => {
    for (const contactId of contactsToDelete) {
      await lifecycle.deleteContact(contactId).catch((_error: unknown): void => undefined);
    }
    for (const aliasId of aliasesToDelete) {
      await lifecycle.delete(aliasId).catch((_error: unknown): void => undefined);
    }
  });

  it("renders and completes creation, update, status, contacts, search, and deletion", async () => {
    const dialogService = mock<DialogService>();
    dialogService.openSimpleDialog.mockResolvedValue(true);

    await TestBed.configureTestingModule({
      imports: [EmailAliasesComponent, NoopAnimationsModule],
      providers: [
        provideRouter([]),
        { provide: WebSimpleLoginAliasService, useValue: facade },
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

    const fixture: ComponentFixture<EmailAliasesComponent> =
      TestBed.createComponent(EmailAliasesComponent);
    const component = fixture.componentInstance;
    component["dialogService"] = dialogService;
    fixture.detectChanges();
    await fixture.whenStable();
    await component.ngOnInit();
    fixture.detectChanges();

    expect(component.error).toBeUndefined();
    expect(component.domains.length).toBeGreaterThan(0);
    expect(fixture.nativeElement.querySelector("[data-testid='alias-domains']")).not.toBeNull();

    const marker = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    component.website = `https://web-${marker}.integration.test/register`;
    fixture.detectChanges();
    await component.recommend();
    expect(component.recommendation).toMatchObject({
      hostname: `web-${marker}.integration.test`,
      canCreate: true,
    });
    const createButton = Array.from<HTMLButtonElement>(
      fixture.nativeElement.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("createEmailAlias"));
    expect(createButton).toBeDefined();
    await component.createAlias();
    fixture.detectChanges();

    const aliasId = component.selected?.id;
    expect(aliasId).toEqual(expect.any(Number));
    aliasesToDelete.add(aliasId!);
    expect(
      fixture.nativeElement.querySelector("[data-testid='alias-detail']")?.textContent,
    ).toContain(component.selected?.address);

    await component.recommend();
    expect(component.recommendation?.alias).toMatchObject({
      id: aliasId,
      address: component.selected?.address,
    });

    component.selected!.name = `Web alias ${marker}`;
    component.selected!.note = `Rendered integration ${marker}`;
    component.selected!.pinned = true;
    await component.saveAlias();
    expect(component.selected).toMatchObject({ name: `Web alias ${marker}`, pinned: true });

    await component.setEnabled(false);
    expect(component.selected?.enabled).toBe(false);
    await component.setEnabled(true);
    expect(component.selected?.enabled).toBe(true);

    component.reverseAliasContact = `contact-${marker}@example.net`;
    await component.createReverseAlias();
    const contact = component.contacts[0] as SimpleLoginContact;
    contactsToDelete.add(contact.id);
    expect(contact.reverseAliasAddress).toContain("@");
    await component.toggleContact(contact);
    expect(contact.blocked).toBe(true);
    await component.removeContact(contact);
    contactsToDelete.delete(contact.id);

    component.query = component.selected!.address;
    await component.search();
    expect(component.aliases.some((item) => item.id === aliasId)).toBe(true);

    await component.deleteAlias();
    aliasesToDelete.delete(aliasId!);
    expect(component.selected).toBeUndefined();
    expect(
      (await lifecycle.list(0, `web-${marker}`)).items.some((item) => item.id === aliasId),
    ).toBe(false);
    fixture.destroy();
  });
});
