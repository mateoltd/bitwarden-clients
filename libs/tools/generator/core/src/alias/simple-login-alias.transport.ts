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

function sanitizeRemoteMessage(message: unknown, token: string): string | undefined {
  if (typeof message !== "string") {
    return undefined;
  }

  const withoutToken = token ? message.split(token).join("[redacted]") : message;
  const normalized = withoutToken.replace(/[\r\n\t]+/g, " ").trim();
  return normalized ? normalized.slice(0, 512) : undefined;
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
    let url: URL;
    try {
      const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
      url = new URL(path.replace(/^\//, ""), normalizedBase);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
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

    const response = await this.api.nativeFetch(
      new Request(url, {
        method: options.method ?? "GET",
        headers,
        body,
        redirect: "manual",
        cache: "no-store",
      }),
    );

    const text = await response.text();
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
      const message =
        sanitizeRemoteMessage(json?.error ?? json?.message, token) ??
        `SimpleLogin request failed (${response.status})`;
      const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
      throw new SimpleLoginAliasError(
        message,
        errorCode(response.status),
        response.status,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      );
    }

    return json as Result;
  }
}
