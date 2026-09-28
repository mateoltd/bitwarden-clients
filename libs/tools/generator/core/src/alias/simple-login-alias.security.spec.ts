/** @jest-environment node */

import * as http from "node:http";
import { IncomingMessage, ServerResponse } from "node:http";

import { createSimpleLoginAliasService } from "./simple-login-alias.service";

const connectionId = "11111111-1111-4111-8111-111111111111";
const token = "provider-secret-must-not-leak";

async function server(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const instance = http.createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind a TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        instance.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe("canonical alias SDK transport hardening", () => {
  jest.setTimeout(30_000);

  it("rejects authenticated redirects without sending the token to the target", async () => {
    let redirectedAuthentication: string | undefined;
    const target = await server((request, response) => {
      redirectedAuthentication = request.headers.authentication as string | undefined;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"aliases":[]}');
    });
    const source = await server((_request, response) => {
      response.writeHead(302, { Location: `${target.url}/collect` });
      response.end();
    });

    try {
      const service = createSimpleLoginAliasService({ token, baseUrl: source.url, connectionId });
      await expect(service.list()).rejects.toMatchObject({
        code: "invalid-response",
        status: 302,
        message: "alias operation failed: invalid-response",
      });
      expect(redirectedAuthentication).toBeUndefined();
    } finally {
      await source.close();
      await target.close();
    }
  });

  it("enforces the SDK response bound on a real streamed HTTP response", async () => {
    const source = await server((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ aliases: [], padding: "x".repeat(600_000) }));
    });

    try {
      const service = createSimpleLoginAliasService({ token, baseUrl: source.url, connectionId });
      await expect(service.list()).rejects.toMatchObject({
        code: "invalid-response",
        message: "alias operation failed: invalid-response",
      });
    } finally {
      await source.close();
    }
  });

  it("does not render a credential-reflecting provider error body", async () => {
    const source = await server((_request, response) => {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: `<script>${token}</script>` }));
    });

    try {
      const service = createSimpleLoginAliasService({ token, baseUrl: source.url, connectionId });
      let error: Error & { code?: string; status?: number };
      try {
        await service.list();
        throw new Error("expected authentication to fail");
      } catch (caught) {
        error = caught as Error & { code?: string; status?: number };
      }
      expect(error).toMatchObject({ code: "invalid-credentials", status: 401 });
      expect(error.message).not.toContain(token);
      expect(error.message).not.toContain("script");
    } finally {
      await source.close();
    }
  });
});
