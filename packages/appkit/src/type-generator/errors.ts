/**
 * Shared error-introspection utilities for the type generator.
 *
 * Both describe paths — the query registry and the metric-view registry — must
 * classify a thrown failure the same way: a transient connectivity blip (which
 * self-converges and should never fail a build) versus a deterministic failure
 * (auth, bad warehouse id, truncated result, malformed request) that must be
 * surfaced. Keeping `isConnectivityError` (and the message/diagnostic helpers it
 * shares) in one module is the single source of truth for that decision, so the
 * two paths can never drift apart.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isObject(error) && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

export function getErrorDiagnostic(error: unknown): string {
  const seen = new Set<unknown>();
  const messages: string[] = [];
  const stack = [error];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    const message = getErrorMessage(current);
    if (
      message &&
      message !== "[object Object]" &&
      !messages.includes(message)
    ) {
      messages.push(message);
    }

    const code = getErrorCode(current);
    if (code && !messages.includes(code)) messages.push(code);

    stack.push(...getErrorChildren(current));
  }

  return messages.length > 0 ? messages.join(": ") : getErrorMessage(error);
}

function getErrorCode(error: unknown): string | undefined {
  if (!isObject(error)) return undefined;
  const code = error.code ?? error.errno;
  return typeof code === "string" ? code : undefined;
}

function getErrorStatus(error: unknown): number | undefined {
  if (!isObject(error)) return undefined;
  const direct = error.status ?? error.statusCode;
  if (typeof direct === "number") return direct;
  if (isObject(error.response) && typeof error.response.status === "number") {
    return error.response.status;
  }
  return undefined;
}

function getErrorChildren(error: unknown): unknown[] {
  if (!isObject(error)) return [];
  const children: unknown[] = [];
  if ("cause" in error) children.push(error.cause);
  if (error instanceof AggregateError) children.push(...error.errors);
  return children;
}

const CONNECTIVITY_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EAI_NODATA",
  "EAI_NONAME",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function isConnectivityMessage(message: string): boolean {
  return (
    /\bconnection (?:refused|reset|timed out)\b/i.test(message) ||
    /\bsocket hang up\b/i.test(message) ||
    /\bnetwork error\b/i.test(message) ||
    /\bcan'?t connect to\b/i.test(message) ||
    /\bcertificate has expired\b/i.test(message) ||
    /\bunable to verify the first certificate\b/i.test(message) ||
    /\bupstream connect error or disconnect\/reset before headers\b/i.test(
      message,
    )
  );
}

/**
 * True when a thrown failure is a transport/connectivity problem (DNS, refused
 * connection, reset, TLS, 502/503/504, undici `UND_ERR_*`) rather than a
 * deterministic error the warehouse returned. Walks `cause`/`AggregateError`
 * chains so a wrapped connectivity error is still recognized. Callers degrade
 * (and retry) on `true`; everything else is surfaced as a build failure.
 */
export function isConnectivityError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const stack = [error];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    const code = getErrorCode(current);
    if (
      code &&
      (CONNECTIVITY_ERROR_CODES.has(code) || code.startsWith("UND_ERR_"))
    ) {
      return true;
    }

    const status = getErrorStatus(current);
    if (status === 502 || status === 503 || status === 504) return true;

    if (isConnectivityMessage(getErrorMessage(current))) return true;

    stack.push(...getErrorChildren(current));
  }

  return false;
}
