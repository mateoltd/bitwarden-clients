import { ReadableStream } from "node:stream/web";

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

  it.each([
    ["-1", undefined],
    ["not-a-date", undefined],
    ["999999", 300],
  ])("bounds an untrusted Retry-After value: %s", async (retryAfter, expected) => {
    api.nativeFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: { "Retry-After": retryAfter },
      }),
    );

    await expect(transport.request(settings, "api/v2/aliases")).rejects.toMatchObject({
      code: "rate-limited",
      retryAfterSeconds: expected,
    });
  });

  it("does not render untrusted remote error text or the configured token", async () => {
    api.nativeFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: `<img src=x> invalid ${settings.token}` }), {
        status: 401,
      }),
    );

    let error: SimpleLoginAliasError | undefined;
    try {
      await transport.request(settings, "api/user_info");
    } catch (caught) {
      error = caught as SimpleLoginAliasError;
    }

    expect(error?.code).toBe("invalid-credentials");
    expect(error?.message).toBe("SimpleLogin credentials were rejected");
    expect(error?.message).not.toContain("<img");
    expect(error?.message).not.toContain(settings.token);
  });

  it.each([
    "http://simplelogin.example",
    "ftp://simplelogin.example",
    "https://user:password@simplelogin.example",
    "https://simplelogin.example?destination=untrusted",
  ])("rejects an unsafe provider URL before sending credentials: %s", async (baseUrl) => {
    const result = transport.request({ ...settings, baseUrl }, "api/v2/aliases");

    await expect(result).rejects.toMatchObject({ code: "invalid-response" });
    expect(api.nativeFetch).not.toHaveBeenCalled();
  });

  it("allows an HTTP loopback endpoint for local development and integration", async () => {
    api.nativeFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(
      transport.request({ ...settings, baseUrl: "http://127.0.0.1:32769" }, "api/user_info"),
    ).resolves.toEqual({ ok: true });
  });

  it("prevents an absolute request path from sending the token to another origin", async () => {
    const result = transport.request(settings, "https://untrusted.example/collect");

    await expect(result).rejects.toMatchObject({ code: "invalid-response" });
    expect(api.nativeFetch).not.toHaveBeenCalled();
  });

  it("rejects followed cross-origin redirects and oversized responses", async () => {
    const redirected = new Response(JSON.stringify({ ok: true }), { status: 200 });
    Object.defineProperties(redirected, {
      redirected: { value: true },
      url: { value: "https://untrusted.example/collect" },
    });
    api.nativeFetch.mockResolvedValueOnce(redirected).mockResolvedValueOnce(
      new Response("x", {
        status: 200,
        headers: { "Content-Length": "2000001" },
      }),
    );

    await expect(transport.request(settings, "api/v2/aliases")).rejects.toMatchObject({
      code: "invalid-response",
    });
    await expect(transport.request(settings, "api/v2/aliases")).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("bounds a streamed response without relying on Content-Length", async () => {
    const oversized = new Uint8Array(2_000_001);
    api.nativeFetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(oversized);
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );

    await expect(transport.request(settings, "api/v2/aliases")).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("classifies offline failures without exposing request details or credentials", async () => {
    api.nativeFetch.mockRejectedValue(
      new TypeError(`fetch failed for ${settings.baseUrl}?access_token=${settings.token}`),
    );

    const result = transport.request(settings, "api/v2/aliases");

    await expect(result).rejects.toMatchObject({
      name: "SimpleLoginAliasError",
      code: "remote-error",
      message: "SimpleLogin could not be reached",
    });
    await expect(result).rejects.not.toThrow(settings.token);
  });

  it("bounds a provider request that never settles", async () => {
    jest.useFakeTimers();
    const abort = jest.spyOn(AbortController.prototype, "abort");
    api.nativeFetch.mockReturnValue(new Promise<Response>(() => undefined));
    const result = transport.request(settings, "api/v2/aliases");
    const expectation = expect(result).rejects.toMatchObject({
      code: "remote-error",
      message: "SimpleLogin could not be reached",
    });

    await jest.advanceTimersByTimeAsync(15_000);

    await expectation;
    expect(abort).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it("bounds a provider response body that never settles", async () => {
    jest.useFakeTimers();
    api.nativeFetch.mockResolvedValue(
      new Response(new ReadableStream({ start: () => undefined }), { status: 200 }),
    );
    const result = transport.request(settings, "api/v2/aliases");
    const expectation = expect(result).rejects.toMatchObject({
      code: "remote-error",
      message: "SimpleLogin could not be reached",
    });

    await jest.advanceTimersByTimeAsync(15_000);

    await expectation;
    jest.useRealTimers();
  });
});
