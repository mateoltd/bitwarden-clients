import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { ApiSettings, RestClient } from "@bitwarden/common/tools/integration/rpc";

import { Forwarder } from "../engine/forwarder";
import { SimpleLogin } from "../integration/simple-login";
import { GeneratedCredential } from "../types";

import { SimpleLoginAliasService } from "./simple-login-alias.service";
import { SimpleLoginAliasTransport } from "./simple-login-alias.transport";

const integrationEnabled = process.env["SIMPLELOGIN_INTEGRATION"] === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("SimpleLogin real API integration", () => {
  const baseUrl = process.env["SIMPLELOGIN_BASE_URL"] ?? "http://127.0.0.1:7777";
  const email = process.env["SIMPLELOGIN_EMAIL"] ?? "john@wick.com";
  const password = process.env["SIMPLELOGIN_PASSWORD"] ?? "password";
  const api = {
    nativeFetch: (request: Request) => fetch(request),
  } as ApiService;
  const i18n = {
    t: (key: string, ...values: string[]) => `${key} ${values.join(" ")}`.trim(),
  } as I18nService;

  let token: string;
  let service: SimpleLoginAliasService;
  const aliasesToDelete = new Set<number>();
  const contactsToDelete = new Set<number>();

  beforeAll(async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password, device: "Bitwarden alias integration test" }),
      redirect: "manual",
    });
    const body = (await response.json()) as { api_key?: unknown };
    if (!response.ok || typeof body?.api_key !== "string") {
      throw new Error(`SimpleLogin test login failed (${response.status})`);
    }

    token = body.api_key;
    service = new SimpleLoginAliasService(new SimpleLoginAliasTransport(api), { token, baseUrl });
  });

  afterAll(async () => {
    for (const contactId of contactsToDelete) {
      await service.deleteContact(contactId).catch((_error: unknown): void => undefined);
    }
    for (const aliasId of aliasesToDelete) {
      await service.delete(aliasId).catch((_error: unknown): void => undefined);
    }
  });

  it("retains generator identity and completes lifecycle operations", async () => {
    const marker = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const hostname = `alias-${marker}.integration.test`;
    const forwarder = new Forwarder(SimpleLogin, new RestClient(api, i18n), i18n);

    const generated = await forwarder.generate(
      {
        algorithm: { forwarder: "simplelogin" } as any,
        website: hostname,
        source: "integration test",
      },
      { token, baseUrl } as ApiSettings,
    );
    const aliasId = Number(generated.metadata?.alias.id);
    aliasesToDelete.add(aliasId);

    expect(generated).toMatchObject({
      category: "email",
      website: hostname,
      metadata: {
        kind: "email-alias",
        alias: { provider: "simplelogin", id: expect.any(String) },
      },
    });
    expect(generated.metadata?.alias.address).toBe(generated.credential);
    expect(Number.isSafeInteger(aliasId)).toBe(true);

    const detail = await service.get(aliasId);
    expect(detail).toMatchObject({ id: aliasId, address: generated.credential });

    const search = await service.list(0, generated.credential);
    expect(search.items.some((alias) => alias.id === aliasId)).toBe(true);

    const recommendation = await service.recommend(hostname);
    expect(recommendation.alias).toMatchObject({ id: aliasId, address: generated.credential });

    const updated = await service.update(aliasId, { name: `Bitwarden ${marker}`, pinned: true });
    expect(updated).toMatchObject({ id: aliasId, name: `Bitwarden ${marker}`, pinned: true });

    expect(await service.setEnabled(aliasId, false)).toMatchObject({ enabled: false });
    expect(await service.setEnabled(aliasId, true)).toMatchObject({ enabled: true });
    expect((await service.domains()).length).toBeGreaterThan(0);

    const contact = await service.createReverseAlias(aliasId, `contact-${marker}@example.net`);
    contactsToDelete.add(contact.id);
    expect(contact.reverseAliasAddress).toContain("@");
    expect((await service.contacts(aliasId)).items.some((item) => item.id === contact.id)).toBe(
      true,
    );
    expect(await service.toggleContactBlocked(contact.id)).toBe(true);
    await service.deleteContact(contact.id);
    contactsToDelete.delete(contact.id);

    // Generator serialization is the history boundary: identity and provider credentials stay out.
    const serializedForHistory = GeneratedCredential.fromJSON(generated.toJSON());
    expect(serializedForHistory.metadata).toBeUndefined();
    expect(JSON.stringify(serializedForHistory)).not.toContain(token);
    expect(JSON.stringify(detail)).not.toContain(token);
  });
});
