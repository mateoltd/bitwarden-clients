export type SimpleLoginAliasErrorCode =
  | "invalid-credentials"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "conflict"
  | "remote-error"
  | "invalid-response";

/** Stable UI error categories whose messages contain only SDK-controlled safe text. */
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

export function normalizeSimpleLoginAliasError(error: unknown): SimpleLoginAliasError {
  if (error instanceof SimpleLoginAliasError) {
    return error;
  }
  if (!(error instanceof Error) || error.name !== "AliasError") {
    return new SimpleLoginAliasError("SimpleLogin could not be reached", "remote-error");
  }

  const message = error.message;
  const statusMatch = /\(HTTP (\d{3})\)/.exec(message);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  if (message === "alias provider authentication failed" || status === 401) {
    return new SimpleLoginAliasError(message, "invalid-credentials", status ?? 401);
  }
  if (status === 403) {
    return new SimpleLoginAliasError(message, "forbidden", status);
  }
  if (status === 404) {
    return new SimpleLoginAliasError(message, "not-found", status);
  }
  if (message === "alias provider rate limit reached" || status === 429) {
    return new SimpleLoginAliasError(message, "rate-limited", status ?? 429);
  }
  if (
    message.startsWith("invalid alias") ||
    message.startsWith("alias provider response exceeded") ||
    message.startsWith("alias provider returned")
  ) {
    return new SimpleLoginAliasError(message, "invalid-response", status);
  }
  return new SimpleLoginAliasError(message, "remote-error", status);
}
