/** @jest-environment node */

import { createServer } from "http";

import {
  AliasSyncDocument,
  createAliasSyncDocument,
  projectAliasSync,
} from "@bitwarden/common/tools/alias";

import { createSimpleLoginAliasService } from "./simple-login-alias.service";

const connectionId = "11111111-1111-4111-8111-111111111111";

describe("SimpleLogin provider operation journal", () => {
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

  it("does not retry a create whose provider outcome became unknown", async () => {
    let requests = 0;
    const server = createServer((request) => {
      requests += 1;
      request.socket.destroy();
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
  });
});
