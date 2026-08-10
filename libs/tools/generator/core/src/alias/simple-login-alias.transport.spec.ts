import { mock } from "jest-mock-extended";

import { ApiService } from "@bitwarden/common/abstractions/api.service";

import { SimpleLoginAliasError, SimpleLoginAliasTransport } from "./simple-login-alias.transport";

describe("SimpleLoginAliasTransport", () => {
  const api = mock<ApiService>();
  const transport = new SimpleLoginAliasTransport(api);
  const settings = { token: "provider-secret", baseUrl: "https://sl.example.test" };

  afterEach(() => jest.resetAllMocks());

  it("uses the SimpleLogin authentication header without redirects or caching", async () => {
    api.nativeFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      transport.request(settings, "api/v2/aliases", { query: { page_id: 2 } }),
    ).resolves.toEqual({ ok: true });

    const request = api.nativeFetch.mock.calls[0][0];
    expect(request.url).toBe("https://sl.example.test/api/v2/aliases?page_id=2");
    expect(request.headers.get("Authentication")).toBe(settings.token);
    expect(request.cache).toBe("no-store");
    expect(request.redirect).toBe("manual");
  });

  it("classifies rate limits and exposes Retry-After", async () => {
    api.nativeFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: { "Retry-After": "12" },
      }),
    );

    const result = transport.request(settings, "api/alias/random/new", { method: "POST" });

    await expect(result).rejects.toMatchObject({
      code: "rate-limited",
      status: 429,
      retryAfterSeconds: 12,
    });
  });

  it("redacts the configured token from remote error messages", async () => {
    api.nativeFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: `invalid ${settings.token}` }), { status: 401 }),
    );

    let error: SimpleLoginAliasError | undefined;
    try {
      await transport.request(settings, "api/user_info");
    } catch (caught) {
      error = caught as SimpleLoginAliasError;
    }

    expect(error?.code).toBe("invalid-credentials");
    expect(error?.message).toBe("invalid [redacted]");
    expect(error?.message).not.toContain(settings.token);
  });
});
