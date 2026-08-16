import {
  AliasSyncDocument,
  appendAliasSyncEvent,
  createAliasSyncDocument,
  projectAliasSync,
} from "@bitwarden/common/tools/alias";

import { createSimpleLoginAliasService } from "./simple-login-alias.service";

const connectionId = "11111111-1111-4111-8111-111111111111";

describe("SimpleLoginAliasService", () => {
  it.each([
    "http://simplelogin.example",
    "ftp://simplelogin.example",
    "https://user:password@simplelogin.example",
    "https://simplelogin.example?destination=untrusted",
  ])("lets the SDK reject an unsafe provider URL before any request: %s", (baseUrl) => {
    expect(() =>
      createSimpleLoginAliasService({ token: "provider-secret", baseUrl, connectionId }),
    ).toThrow(expect.objectContaining({ code: "invalid-response" }));
  });

  it("allows the SDK's loopback-only HTTP integration exception", () => {
    const service = createSimpleLoginAliasService({
      token: "provider-secret",
      baseUrl: "http://127.0.0.1:32769",
      connectionId,
    });

    expect(service.providerIdentity()).toMatchObject({
      version: 1,
      connectionId,
      adapter: { adapterId: "simplelogin" },
    });
  });

  it("rejects malformed connection identities instead of silently replacing them", () => {
    expect(() =>
      createSimpleLoginAliasService({
        token: "provider-secret",
        baseUrl: "https://app.simplelogin.io",
        connectionId: "not-a-uuid",
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-response" }));
  });

  it("never copies an invalid provider token into the translated error", () => {
    const token = "private-token\nnot-a-header";
    try {
      createSimpleLoginAliasService({ token, connectionId });
      throw new Error("expected SDK validation to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid-response" });
      expect((error as Error).message).not.toContain(token);
    }
  });

  it("rejects invalid numeric identifiers before crossing the WASM boundary", async () => {
    const service = createSimpleLoginAliasService({
      token: "provider-secret",
      connectionId,
    });

    await expect(service.get(-1)).rejects.toMatchObject({
      code: "invalid-response",
      message: "SimpleLogin alias id is invalid",
    });
    await expect(service.getCanonical("0")).rejects.toMatchObject({
      code: "invalid-response",
      message: "SimpleLogin alias id is invalid",
    });
    await expect(service.contacts(1, -1)).rejects.toMatchObject({
      code: "invalid-response",
      message: "SimpleLogin page is invalid",
    });
  });

  it("makes connection removal terminal for a stale lifecycle instance", async () => {
    let persisted = createAliasSyncDocument("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const service = createSimpleLoginAliasService({
      token: "provider-secret",
      connectionId,
      syncStore: {
        load: async () => persisted,
        save: async (document) => {
          persisted = document;
        },
      },
    });

    await service.removeConnection();
    await expect(service.create()).rejects.toMatchObject({ code: "conflict" });
    expect(Object.values(projectAliasSync(persisted).connections)[0].status).toBe("removed");
  });

  it("does not resume a prepared provider mutation after observing connection removal", async () => {
    const replicaId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const connection = { version: 1 as const, connectionId };
    let persisted: AliasSyncDocument = createAliasSyncDocument(replicaId);
    persisted = appendAliasSyncEvent(persisted, { kind: "connection-upsert", connection });
    persisted = appendAliasSyncEvent(persisted, {
      kind: "provider-operation",
      value: { operation: "create", connection, request: {} },
    });
    persisted = appendAliasSyncEvent(persisted, { kind: "connection-remove", connection });
    const service = createSimpleLoginAliasService({
      token: "provider-secret",
      connectionId,
      syncStore: {
        load: async () => persisted,
        save: async (document) => {
          persisted = document;
        },
      },
    });

    await expect(service.create()).rejects.toMatchObject({ code: "conflict" });
    expect(persisted.events.some((event) => event.kind === "provider-dispatched")).toBe(false);
  });

  it("persists reference prepare and commit as separate durable states across restart", async () => {
    let persisted = createAliasSyncDocument("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const syncStore = {
      load: async () => persisted,
      save: async (document: AliasSyncDocument) => {
        persisted = document;
      },
    };
    const settings = { token: "provider-secret", connectionId, syncStore };
    const identity = {
      version: 1 as const,
      connectionId,
      aliasId: "41",
      address: "first@sl.test",
    };
    const firstProcess = createSimpleLoginAliasService(settings);

    const transactionId = await firstProcess.prepareReference("cipher-1", undefined, identity);

    expect(transactionId).toBeDefined();
    expect(projectAliasSync(persisted).references["cipher-1"]).toBeUndefined();
    expect(await firstProcess.pendingReferenceTransactions()).toEqual([
      expect.objectContaining({ transactionId, status: "pending" }),
    ]);

    const restarted = createSimpleLoginAliasService(settings);
    await restarted.commitReference(transactionId ?? "");

    expect(projectAliasSync(persisted).references["cipher-1"]).toMatchObject({
      alias: identity,
      conflicted: false,
    });
    await expect(restarted.commitReference(transactionId ?? "")).resolves.toBeUndefined();
  });

  it("compensates a prepared reference without ever projecting it as committed", async () => {
    let persisted = createAliasSyncDocument("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const service = createSimpleLoginAliasService({
      token: "provider-secret",
      connectionId,
      syncStore: {
        load: async () => persisted,
        save: async (document) => {
          persisted = document;
        },
      },
    });
    const identity = {
      version: 1 as const,
      connectionId,
      aliasId: "42",
      address: "second@sl.test",
    };

    const transactionId = await service.prepareReference("cipher-2", undefined, identity);
    await service.abortReference(transactionId ?? "");

    expect(projectAliasSync(persisted).references["cipher-2"]).toBeUndefined();
    expect(projectAliasSync(persisted).referenceTransactions[transactionId ?? ""]).toMatchObject({
      status: "aborted",
    });
  });
});
