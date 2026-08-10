import { mock } from "jest-mock-extended";

import { SimpleLoginAliasService } from "./simple-login-alias.service";
import { SimpleLoginAliasTransport } from "./simple-login-alias.transport";

const aliasJson = (id = 7, email = "shop@sl.test"): any => ({
  id,
  email,
  name: "Shop",
  note: "generated",
  enabled: true,
  pinned: false,
  creation_timestamp: 123,
  nb_block: 1,
  nb_forward: 2,
  nb_reply: 3,
  support_pgp: false,
  disable_pgp: false,
  mailboxes: [{ id: 5, email: "owner@example.test" }],
  latest_activity: null,
});

describe("SimpleLoginAliasService", () => {
  const transport = mock<SimpleLoginAliasTransport>();
  const service = new SimpleLoginAliasService(transport, {
    token: "secret",
    baseUrl: "https://sl.test",
  });

  afterEach(() => jest.resetAllMocks());

  it("creates an alias with stable id and address", async () => {
    transport.request.mockResolvedValue(aliasJson());

    const result = await service.create({ hostname: "https://shop.example/path", mode: "word" });

    expect(result).toMatchObject({ id: 7, address: "shop@sl.test" });
    expect(transport.request).toHaveBeenCalledWith(
      expect.anything(),
      "api/alias/random/new",
      expect.objectContaining({
        method: "POST",
        query: { hostname: "shop.example", mode: "word" },
      }),
    );
  });

  it("resolves a hostname recommendation to stable alias identity", async () => {
    transport.request
      .mockResolvedValueOnce({
        can_create: true,
        prefix_suggestion: "shop",
        suffixes: [],
        recommendation: { alias: "shop@sl.test", hostname: "shop.example" },
      })
      .mockResolvedValueOnce({ aliases: [aliasJson()] });

    const result = await service.recommend("https://shop.example/register");

    expect(result.alias).toMatchObject({ id: 7, address: "shop@sl.test" });
  });

  it("supports search pagination, detail, update, state, delete, domains and reverse aliases", async () => {
    transport.request.mockResolvedValueOnce({ aliases: [aliasJson()] });
    await expect(service.list(0, "shop", "enabled")).resolves.toMatchObject({
      items: [{ id: 7 }],
      page: 0,
    });

    transport.request.mockResolvedValueOnce(aliasJson());
    await expect(service.get(7)).resolves.toMatchObject({ id: 7 });

    transport.request.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(aliasJson());
    await expect(service.update(7, { name: "Updated" })).resolves.toMatchObject({ id: 7 });

    transport.request.mockResolvedValueOnce(aliasJson());
    await expect(service.setEnabled(7, true)).resolves.toMatchObject({ enabled: true });

    transport.request.mockResolvedValueOnce({ deleted: true });
    await expect(service.delete(7)).resolves.toBeUndefined();

    transport.request.mockResolvedValueOnce([{ domain: "sl.test", is_custom: false }]);
    await expect(service.domains()).resolves.toEqual([{ domain: "sl.test", isCustom: false }]);

    const contact: any = {
      id: 8,
      contact: "merchant@example.test",
      reverse_alias: "merchant <reply@sl.test>",
      reverse_alias_address: "reply@sl.test",
      creation_timestamp: 456,
      last_email_sent_timestamp: null,
      block_forward: false,
      existed: false,
    };
    transport.request.mockResolvedValueOnce(contact);
    await expect(service.createReverseAlias(7, contact.contact)).resolves.toMatchObject({
      id: 8,
      reverseAliasAddress: "reply@sl.test",
    });

    transport.request.mockResolvedValueOnce({ contacts: [contact] });
    await expect(service.contacts(7)).resolves.toMatchObject({ items: [{ id: 8 }] });

    transport.request.mockResolvedValueOnce({ block_forward: true });
    await expect(service.toggleContactBlocked(8)).resolves.toBe(true);

    transport.request.mockResolvedValueOnce({ deleted: true });
    await expect(service.deleteContact(8)).resolves.toBeUndefined();
  });
});
