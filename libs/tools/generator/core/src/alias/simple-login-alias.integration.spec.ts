import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";

import { SimpleLoginForwarder } from "../engine/simple-login-forwarder";
import { SimpleLogin } from "../integration/simple-login";
import { GeneratedCredential } from "../types";

import { SimpleLoginAliasError } from "./simple-login-alias.error";
import {
  createSimpleLoginAliasService,
  SimpleLoginAliasService,
} from "./simple-login-alias.service";
import { SimpleLoginContact } from "./simple-login-alias.types";

const integrationEnabled = process.env["SIMPLELOGIN_INTEGRATION"] === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;

function requiredIntegrationSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for SimpleLogin integration tests`);
  }
  return value;
}

describeIntegration("SimpleLogin real API integration", () => {
  const baseUrl = process.env["SIMPLELOGIN_BASE_URL"] ?? "http://127.0.0.1:7777";
  const connectionId = "11111111-1111-4111-8111-111111111111";
  const i18n = {
    t: (key: string, ...values: string[]) => `${key} ${values.join(" ")}`.trim(),
  } as I18nService;

  let token: string;
  let service: SimpleLoginAliasService;
  let lifecycleAlias: { id: number; address: string; hostname: string } | undefined;
  const aliasesToDelete = new Set<number>();
  const contactsToDelete = new Map<number, SimpleLoginContact>();

  beforeAll(async () => {
    const email = requiredIntegrationSetting("SIMPLELOGIN_EMAIL");
    const password = requiredIntegrationSetting("SIMPLELOGIN_PASSWORD");
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
    service = createSimpleLoginAliasService({ token, baseUrl, connectionId });
  });

  afterAll(async () => {
    for (const contact of contactsToDelete.values()) {
      await service.deleteContact(contact).catch((_error: unknown): void => undefined);
    }
    for (const aliasId of aliasesToDelete) {
      await service.delete(aliasId).catch((_error: unknown): void => undefined);
    }
  });

  it("retains generator identity and completes lifecycle operations", async () => {
    const marker = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const hostname = `alias-${marker}.integration.test`;
    const forwarder = new SimpleLoginForwarder(SimpleLogin, i18n, Date.now);

    const generated = await forwarder.generate(
      {
        algorithm: { forwarder: "simplelogin" } as any,
        website: hostname,
        source: "integration test",
      },
      { token, baseUrl, connectionId },
    );
    const aliasId = Number(generated.metadata?.alias.aliasId);
    aliasesToDelete.add(aliasId);
    lifecycleAlias = { id: aliasId, address: generated.credential, hostname };

    expect(generated).toMatchObject({
      category: "email",
      website: hostname,
      metadata: {
        kind: "email-alias",
        alias: {
          version: 1,
          connectionId,
          aliasId: expect.any(String),
        },
      },
    });
    expect(generated.metadata?.alias.address).toBe(generated.credential);
    expect(Number.isSafeInteger(aliasId)).toBe(true);

    const detail = await service.get(aliasId);
    expect(detail).toMatchObject({ id: aliasId, address: generated.credential });

    const search = await service.list(0, generated.credential);
    expect(search.items.some((alias) => alias.id === aliasId)).toBe(true);

    const recommendation = await service.recommend(hostname);
    expect(recommendation).toMatchObject({ hostname, canCreate: true });
    expect(recommendation.suffixes.length).toBeGreaterThan(0);
    if (recommendation.alias) {
      expect(recommendation.alias.identity).toMatchObject({ version: 1, connectionId });
    }

    const updated = await service.update(aliasId, { name: `Bitwarden ${marker}`, pinned: true });
    expect(updated).toMatchObject({ id: aliasId, name: `Bitwarden ${marker}`, pinned: true });

    expect(await service.setEnabled(aliasId, false)).toMatchObject({ enabled: false });
    expect(await service.setEnabled(aliasId, true)).toMatchObject({ enabled: true });
    expect((await service.domains()).length).toBeGreaterThan(0);

    const contact = await service.createReverseAlias(aliasId, `contact-${marker}@example.net`);
    contactsToDelete.set(contact.id, contact);
    expect(contact.reverseAliasAddress).toContain("@");
    expect((await service.contacts(aliasId)).items.some((item) => item.id === contact.id)).toBe(
      true,
    );
    expect(await service.toggleContactBlocked(contact)).toBe(true);
    await service.deleteContact(contact);
    contactsToDelete.delete(contact.id);

    // Generator serialization is the history boundary: identity and provider credentials stay out.
    const serializedForHistory = GeneratedCredential.fromJSON(generated.toJSON());
    expect(serializedForHistory.metadata).toBeUndefined();
    expect(JSON.stringify(serializedForHistory)).not.toContain(token);
    expect(JSON.stringify(detail)).not.toContain(token);
  });

  it("handles concurrent clients, expired credentials, partial failures, and offline state", async () => {
    expect(lifecycleAlias).toBeDefined();
    const secondClient = createSimpleLoginAliasService({
      token,
      baseUrl,
      connectionId,
    });

    const [firstDetail, secondDetail, recommendation] = await Promise.all([
      service.get(lifecycleAlias!.id),
      secondClient.get(lifecycleAlias!.id),
      secondClient.recommend(lifecycleAlias!.hostname),
    ]);
    expect(firstDetail).toMatchObject({
      id: lifecycleAlias!.id,
      address: lifecycleAlias!.address,
    });
    expect(secondDetail).toEqual(firstDetail);
    expect(recommendation).toMatchObject({ hostname: lifecycleAlias!.hostname, canCreate: true });

    let partialFailure: SimpleLoginAliasError | undefined;
    try {
      await service.get(999_999);
    } catch (error) {
      partialFailure = error as SimpleLoginAliasError;
    }
    expect(partialFailure).toMatchObject({ code: "remote-error", status: 400 });
    await expect(service.get(lifecycleAlias!.id)).resolves.toMatchObject({
      id: lifecycleAlias!.id,
    });

    const expiredToken = `expired-${Date.now()}`;
    const expired = createSimpleLoginAliasService({
      token: expiredToken,
      baseUrl,
      connectionId,
    });
    await expect(expired.list()).rejects.toMatchObject({
      code: "invalid-credentials",
      status: 401,
    });
    await expect(expired.list()).rejects.not.toThrow(expiredToken);

    const offline = createSimpleLoginAliasService({
      token,
      baseUrl: "http://127.0.0.1:1",
      connectionId,
    });
    await expect(offline.list()).rejects.toMatchObject({
      code: "remote-error",
      message: "alias operation failed: offline",
    });
  });

  const describeRateLimit =
    process.env["SIMPLELOGIN_RATE_LIMIT_INTEGRATION"] === "1" ? it : it.skip;
  describeRateLimit(
    "classifies the real SimpleLogin 429 response",
    async () => {
      let rateLimit: SimpleLoginAliasError | undefined;
      for (let request = 0; request < 60 && !rateLimit; request++) {
        try {
          await service.list(0);
        } catch (error) {
          const candidate = error as SimpleLoginAliasError;
          if (candidate.code === "rate-limited") {
            rateLimit = candidate;
          } else {
            throw error;
          }
        }
      }

      expect(rateLimit).toMatchObject({ code: "rate-limited", status: 429 });
      // The pinned official SimpleLogin service returns no Retry-After or X-RateLimit headers. The
      // transport unit test separately proves that Retry-After is retained when a server supplies it.
      expect(rateLimit?.retryAfterSeconds).toBeUndefined();
    },
    30_000,
  );
});
