/** @jest-environment node */

import { createServer } from "http";

import { SensitiveString } from "@bitwarden/alias-sdk-internal";
import {
  AliasSyncDocument,
  appendAliasSyncEvent,
  createAliasSyncDocument,
  mergeAliasSyncDocuments,
  parseEmailAliasIdentity,
  projectAliasSync,
} from "@bitwarden/common/tools/alias";

import { createSimpleLoginAliasService } from "./simple-login-alias.service";
import { SimpleLoginContact } from "./simple-login-alias.types";

const connectionId = "11111111-1111-4111-8111-111111111111";

const aliasResponse: Record<string, unknown> = {
  id: 41,
  email: "settled@aliases.example.com",
  name: null,
  note: null,
  enabled: true,
  pinned: false,
  creation_timestamp: 1_700_000_000,
  nb_block: 0,
  nb_forward: 0,
  nb_reply: 0,
  support_pgp: false,
  disable_pgp: false,
  mailboxes: [{ id: 1, email: "owner@example.com" }],
  latest_activity: null,
};

describe("SimpleLogin provider operation journal", () => {
  it("settles the exact operation after a persisted store reorders event ids", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(aliasResponse));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind to a TCP port");
    }
    let persisted = appendAliasSyncEvent(
      createAliasSyncDocument("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      {
        kind: "connection-upsert",
        connection: { version: 1, connectionId },
      },
      "ffffffff-ffff-4fff-bfff-ffffffffffff",
    );
    const syncStore = {
      load: async () => persisted,
      save: async (document: AliasSyncDocument) => {
        persisted = mergeAliasSyncDocuments(persisted, document);
      },
    };

    try {
      const service = createSimpleLoginAliasService({
        token: "encrypted-provider-token",
        baseUrl: `http://127.0.0.1:${address.port}`,
        connectionId,
        syncStore,
      });

      await expect(service.create()).resolves.toMatchObject({ id: 41 });
      const operations = Object.values(projectAliasSync(persisted).operations);
      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({ status: "applied" });
      expect(projectAliasSync(persisted).conflicts).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each(["create", "disable"] as const)(
    "leaves another connection's pending %s untouched during recovery",
    async (operation) => {
      let requests = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(aliasResponse));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind to a TCP port");
      }
      const otherConnectionId = "22222222-2222-4222-8222-222222222222";
      let persisted = appendAliasSyncEvent(createAliasSyncDocument(), {
        kind: "provider-operation",
        value:
          operation === "create"
            ? {
                operation,
                connection: { version: 1, connectionId: otherConnectionId },
                request: {},
              }
            : {
                operation,
                alias: parseEmailAliasIdentity({
                  version: 1,
                  connectionId: otherConnectionId,
                  aliasId: "41",
                  address: "other@aliases.example.com",
                })!,
              },
      });
      const foreignOperationId = persisted.events[0].id;
      try {
        const service = createSimpleLoginAliasService({
          token: "encrypted-provider-token",
          baseUrl: `http://127.0.0.1:${address.port}`,
          connectionId,
          syncStore: {
            load: async () => persisted,
            save: async (document: AliasSyncDocument) => {
              persisted = mergeAliasSyncDocuments(persisted, document);
            },
          },
        });
        await expect(service.create()).resolves.toMatchObject({ id: 41 });
        expect(requests).toBe(1);
        expect(projectAliasSync(persisted).operations[foreignOperationId].status).toBe("prepared");
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it.each(["create", "toggle", "delete"] as const)(
    "rejects contact %s from a stale client after connection removal",
    async (operation) => {
      let requests = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(aliasResponse));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind to a TCP port");
      }
      let persisted = createAliasSyncDocument();
      const alias = parseEmailAliasIdentity({
        version: 1,
        connectionId,
        aliasId: "41",
        address: "settled@aliases.example.com",
      })!;
      const contact: SimpleLoginContact = {
        id: 99,
        address: "contact@example.com",
        reverseAlias: "reverse-token",
        reverseAliasAddress: "reply@aliases.example.com",
        createdAt: 1_700_000_000,
        lastEmailSentAt: null,
        blocked: false,
        existed: false,
        identity: {
          alias,
          identityId: "99",
          recipient: "contact@example.com" as SensitiveString,
          address: "reply@aliases.example.com" as SensitiveString,
          valid: true,
          blocked: false,
        },
      };
      try {
        const service = createSimpleLoginAliasService({
          token: "encrypted-provider-token",
          baseUrl: `http://127.0.0.1:${address.port}`,
          connectionId,
          syncStore: {
            load: async () => persisted,
            save: async (document: AliasSyncDocument) => {
              persisted = document;
            },
          },
        });
        await service.removeConnection();
        const result =
          operation === "create"
            ? service.createReverseAlias(41, contact.address)
            : operation === "toggle"
              ? service.toggleContactBlocked(contact)
              : service.deleteContact(contact);
        await expect(result).rejects.toMatchObject({ code: "conflict" });
        expect(requests).toBe(0);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it("rejects non-v1 journals before any provider mutation", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(500).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind to a TCP port");
    }

    try {
      for (const version of [undefined, 0, "1", 2, 99]) {
        const invalid = {
          ...createAliasSyncDocument("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          version,
        } as unknown as AliasSyncDocument;
        const service = createSimpleLoginAliasService({
          token: "encrypted-provider-token",
          baseUrl: `http://127.0.0.1:${address.port}`,
          connectionId,
          syncStore: {
            load: async () => invalid,
            save: async () => undefined,
          },
        });

        await expect(service.create()).rejects.toThrow();
      }
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each(["connection lost", "invalid JSON", "invalid snapshot", "oversized response"])(
    "does not retry a create after %s leaves its outcome unknown",
    async (failure) => {
      let requests = 0;
      const server = createServer((request, response) => {
        requests += 1;
        if (failure === "connection lost") {
          request.socket.destroy();
        } else {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            failure === "invalid JSON"
              ? "{"
              : JSON.stringify(
                  failure === "oversized response" ? { padding: "x".repeat(600_000) } : {},
                ),
          );
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind to a TCP port");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      let persisted: AliasSyncDocument = createAliasSyncDocument(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      );
      const syncStore = {
        load: async () => persisted,
        save: async (document: AliasSyncDocument) => {
          persisted = document;
        },
      };

      try {
        const firstProcess = createSimpleLoginAliasService({
          token: "encrypted-provider-token",
          baseUrl,
          connectionId,
          syncStore,
        });
        await expect(firstProcess.create()).rejects.toMatchObject({ code: "remote-error" });
        expect(requests).toBe(1);
        expect(Object.values(projectAliasSync(persisted).operations)[0].status).toBe("unknown");
        expect(JSON.stringify(persisted)).not.toContain("encrypted-provider-token");

        const restartedProcess = createSimpleLoginAliasService({
          token: "encrypted-provider-token",
          baseUrl,
          connectionId,
          syncStore,
        });
        await expect(restartedProcess.create()).rejects.toMatchObject({ code: "conflict" });
        expect(requests).toBe(1);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
