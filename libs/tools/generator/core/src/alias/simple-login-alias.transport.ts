import { ApiService } from "@bitwarden/common/abstractions/api.service";

import { SimpleLoginAliasSettings } from "./simple-login-alias.types";

export type SimpleLoginTransportRequest = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

export type SimpleLoginAliasErrorCode =
  | "invalid-credentials"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "remote-error"
  | "invalid-response";

export class SimpleLoginAliasError extends Error {
  constructor(
    message: string,
    readonly code: SimpleLoginAliasErrorCode,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "SimpleLoginAliasError";
  }
}

const DEFAULT_SIMPLELOGIN_BASE_URL = "https://app.simplelogin.io";
const SIMPLELOGIN_REQUEST_TIMEOUT_MS = 15_000;
const SIMPLELOGIN_MAX_RESPONSE_BYTES = 2_000_000;
const SIMPLELOGIN_MAX_RETRY_AFTER_SECONDS = 300;

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function errorCode(status: number): SimpleLoginAliasErrorCode {
  switch (status) {
    case 401:
      return "invalid-credentials";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 429:
      return "rate-limited";
    default:
      return "remote-error";
  }
}

function safeErrorMessage(status: number): string {
  switch (status) {
    case 401:
      return "SimpleLogin credentials were rejected";
    case 403:
      return "SimpleLogin denied the request";
    case 404:
      return "The SimpleLogin item was not found";
    case 429:
      return "SimpleLogin rate limit reached";
    default:
      return `SimpleLogin request failed (${status})`;
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const numericSeconds = Number(value);
  const seconds = Number.isFinite(numericSeconds)
    ? numericSeconds
    : Math.ceil((Date.parse(value) - Date.now()) / 1_000);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }

  return Math.min(Math.ceil(seconds), SIMPLELOGIN_MAX_RETRY_AFTER_SECONDS);
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > SIMPLELOGIN_MAX_RESPONSE_BYTES) {
      throw new SimpleLoginAliasError(
        "SimpleLogin returned an invalid response",
        "invalid-response",
        response.status,
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  const cancel = (): void => {
    void reader.cancel().catch((): void => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return text + decoder.decode();
      }
      size += value.byteLength;
      if (size > SIMPLELOGIN_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch((): void => undefined);
        throw new SimpleLoginAliasError(
          "SimpleLogin returned an invalid response",
          "invalid-response",
          response.status,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Angular-independent production transport for authenticated SimpleLogin API calls. */
export class SimpleLoginAliasTransport {
  constructor(private readonly api: ApiService) {}

  async request<Result>(
    settings: SimpleLoginAliasSettings,
    path: string,
    options: SimpleLoginTransportRequest = {},
  ): Promise<Result> {
    const token = settings.token?.trim();
    if (!token) {
      throw new SimpleLoginAliasError("SimpleLogin credentials are missing", "invalid-credentials");
    }

    const baseUrl = settings.baseUrl?.trim() || DEFAULT_SIMPLELOGIN_BASE_URL;
    let base: URL;
    let url: URL;
    try {
      const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
      base = new URL(normalizedBase);
      url = new URL(path.replace(/^\//, ""), base);
      if (
        (base.protocol !== "https:" &&
          !(base.protocol === "http:" && isLoopbackHostname(base.hostname))) ||
        base.username !== "" ||
        base.password !== "" ||
        base.search !== "" ||
        base.hash !== "" ||
        url.origin !== base.origin
      ) {
        throw new Error("unsupported protocol");
      }
    } catch {
      throw new SimpleLoginAliasError("SimpleLogin API URL is invalid", "invalid-response");
    }

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = new Headers({
      Authentication: token,
      Accept: "application/json",
    });
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }

    let response: Response;
    let text: string;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      const requestInit: RequestInit = {
        method: options.method ?? "GET",
        headers,
        body,
        redirect: "manual",
        cache: "no-store",
      };
      let request: Request;
      try {
        request = new Request(url, { ...requestInit, signal: controller.signal });
      } catch {
        // Older WebViews and mixed DOM/fetch runtimes can reject an otherwise valid AbortSignal.
        // The caller remains time-bounded and response streaming is still cancelled on timeout.
        request = new Request(url, requestInit);
      }
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = globalThis.setTimeout(() => {
          controller.abort();
          reject(new SimpleLoginAliasError("SimpleLogin could not be reached", "remote-error"));
        }, SIMPLELOGIN_REQUEST_TIMEOUT_MS);
      });
      const operation = async () => {
        const providerResponse = await this.api.nativeFetch(request);
        response = providerResponse;
        if (
          providerResponse.redirected === true ||
          (typeof providerResponse.url === "string" &&
            providerResponse.url !== "" &&
            new URL(providerResponse.url).origin !== url.origin) ||
          Number(providerResponse.headers.get("Content-Length")) > SIMPLELOGIN_MAX_RESPONSE_BYTES
        ) {
          await providerResponse.body?.cancel().catch((): void => undefined);
          throw new SimpleLoginAliasError(
            "SimpleLogin returned an invalid response",
            "invalid-response",
            providerResponse.status,
          );
        }
        return {
          response: providerResponse,
          text: await readBoundedResponse(providerResponse, controller.signal),
        };
      };
      ({ response, text } = await Promise.race([operation(), timeout]));
    } catch (error) {
      if (error instanceof SimpleLoginAliasError) {
        throw error;
      }
      throw new SimpleLoginAliasError("SimpleLogin could not be reached", "remote-error");
    } finally {
      if (timeoutId !== undefined) {
        globalThis.clearTimeout(timeoutId);
      }
    }
    let json: any;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (response.status >= 200 && response.status < 300) {
          throw new SimpleLoginAliasError(
            "SimpleLogin returned an invalid response",
            "invalid-response",
            response.status,
          );
        }
      }
    }

    if (response.status < 200 || response.status >= 300) {
      throw new SimpleLoginAliasError(
        safeErrorMessage(response.status),
        errorCode(response.status),
        response.status,
        parseRetryAfter(response.headers.get("Retry-After")),
      );
    }

    return json as Result;
  }
}
