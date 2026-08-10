import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { mock } from "jest-mock-extended";

import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { DialogService, ToastService } from "@bitwarden/components";
import {
  SimpleLoginAliasError,
  SimpleLoginAliasService,
  SimpleLoginAliasTransport,
} from "@bitwarden/generator-core";

import { DesktopHeaderComponent } from "../../layout/header";

import { DesktopAliasComponent } from "./desktop-alias.component";
import { DesktopAliasService } from "./desktop-alias.service";

const integrationEnabled = process.env["SIMPLELOGIN_INTEGRATION"] === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;

@Component({
  selector: "app-header",
  template: "<ng-content />",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class MockDesktopHeaderComponent {
  readonly title = input<string>();
  readonly icon = input<string>();
}

class NodeRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body?: string;

  constructor(input: URL, init: RequestInit = {}) {
    this.url = input.toString();
    this.method = init.method ?? "GET";
    this.headers = init.headers as Headers;
    this.body = init.body as string | undefined;
  }
}

async function nodeFetch(input: string | NodeRequest, init: RequestInit = {}): Promise<Response> {
  const request = typeof input === "string" ? new NodeRequest(new URL(input), init) : input;
  const url = new URL(request.url);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise<Response>((resolve, reject) => {
    const outgoing = send(
      url,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              value.forEach((item) => headers.append(key, item));
            } else if (value != null) {
              headers.set(key, value);
            }
          }
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: incoming.statusCode ?? 0,
            ok: (incoming.statusCode ?? 0) >= 200 && (incoming.statusCode ?? 0) < 300,
            headers,
            text: async () => text,
            json: async () => JSON.parse(text),
          } as Response);
        });
      },
    );
    outgoing.on("error", reject);
    if (request.body != null) {
      outgoing.write(request.body);
    }
    outgoing.end();
  });
}

describeIntegration("Desktop alias rendered real SimpleLogin integration", () => {
  jest.setTimeout(120_000);

  const baseUrl = process.env["SIMPLELOGIN_BASE_URL"] ?? "http://127.0.0.1:32769";
  const email = process.env["SIMPLELOGIN_EMAIL"] ?? "john@wick.com";
  const password = process.env["SIMPLELOGIN_PASSWORD"] ?? "password";
  const originalRequest = global.Request;

  let client: SimpleLoginAliasService;
  let facade: {
    client: jest.Mock<Promise<SimpleLoginAliasService>, []>;
    boundLogins: jest.Mock;
  };
  let fixture: ComponentFixture<DesktopAliasComponent>;
  let aliasId: number | undefined;
  let contactId: number | undefined;

  beforeAll(async () => {
    global.Request = NodeRequest as any;
    const login = await nodeFetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: new Headers({ Accept: "application/json", "Content-Type": "application/json" }),
      body: JSON.stringify({
        email,
        password,
        device: "Bitwarden desktop alias rendered integration test",
      }),
    });
    const body = (await login.json()) as { api_key?: unknown };
    if (!login.ok || typeof body.api_key !== "string") {
      throw new Error(`SimpleLogin test login failed (${login.status})`);
    }

    const api = {
      nativeFetch: (request: globalThis.Request) => nodeFetch(request as any),
    } as ApiService;
    client = new SimpleLoginAliasService(new SimpleLoginAliasTransport(api), {
      token: body.api_key,
      baseUrl,
    });
  });

  afterAll(async () => {
    if (contactId != null) {
      await client.deleteContact(contactId).catch((_error: unknown): void => undefined);
    }
    if (aliasId != null) {
      await client.delete(aliasId).catch((_error: unknown): void => undefined);
    }
    global.Request = originalRequest;
  });

  beforeEach(async () => {
    facade = {
      client: jest.fn().mockResolvedValue(client),
      boundLogins: jest.fn().mockResolvedValue([]),
    };
    const i18n = mock<I18nService>();
    i18n.t.mockImplementation((key: string, ...values: string[]) =>
      [key, ...values].filter(Boolean).join(" "),
    );

    await TestBed.configureTestingModule({
      imports: [DesktopAliasComponent],
      providers: [
        { provide: DesktopAliasService, useValue: facade },
        { provide: DialogService, useValue: mock<DialogService>() },
        { provide: I18nService, useValue: i18n },
        { provide: Router, useValue: mock<Router>() },
        { provide: ToastService, useValue: mock<ToastService>() },
      ],
    })
      .overrideComponent(DesktopAliasComponent, {
        remove: { imports: [DesktopHeaderComponent] },
        add: { imports: [MockDesktopHeaderComponent] },
      })
      .compileComponents();
  });

  afterEach(() => {
    fixture?.destroy();
    TestBed.resetTestingModule();
  });

  it("renders lifecycle state and recovers after lock and restart", async () => {
    const marker = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const created = await client.create({ hostname: `desktop-${marker}.integration.test` });
    aliasId = created.id;

    const boundLogin = new CipherView();
    boundLogin.id = "real-synced-cipher" as any;
    boundLogin.name = `Bound desktop login ${marker}`;
    boundLogin.login.username = created.address;
    boundLogin.aliasBinding = {
      version: 1,
      provider: "simplelogin",
      id: created.id.toString(),
      address: created.address,
    };
    facade.boundLogins.mockResolvedValue([boundLogin]);

    fixture = TestBed.createComponent(DesktopAliasComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    await (fixture.componentInstance as any).selectAlias(created);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(created.address);
    expect(fixture.nativeElement.textContent).toContain(boundLogin.name);
    expect(fixture.nativeElement.textContent).toContain(`ID ${created.id}`);

    (fixture.componentInstance as any).editName.set(`Desktop ${marker}`);
    await (fixture.componentInstance as any).saveAlias();
    expect(await client.get(created.id)).toMatchObject({ name: `Desktop ${marker}` });

    (fixture.componentInstance as any).newContact.set(`contact-${marker}@example.net`);
    await (fixture.componentInstance as any).createReverseAlias();
    const contacts = await client.contacts(created.id);
    const contact = contacts.items.find((item) => item.address === `contact-${marker}@example.net`);
    expect(contact?.reverseAliasAddress).toContain("@");
    contactId = contact?.id;

    fixture.destroy();
    facade.client.mockRejectedValue(
      new SimpleLoginAliasError("SimpleLogin credentials are missing", "invalid-credentials"),
    );
    fixture = TestBed.createComponent(DesktopAliasComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("aliasConfigureSimpleLogin");

    fixture.destroy();
    facade.client.mockResolvedValue(client);
    fixture = TestBed.createComponent(DesktopAliasComponent);
    fixture.detectChanges();
    await (fixture.componentInstance as any).reload();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(created.address);

    if (contactId != null) {
      await client.deleteContact(contactId);
      contactId = undefined;
    }
    await client.delete(created.id);
    aliasId = undefined;
  });
});
