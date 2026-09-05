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

const AUTH_ERROR_STATUSES = new Set([401, 403]);

/**
 * Classifies a thrown failure into one of two buckets: deterministic failures
 * that must be surfaced (bad warehouse id, malformed request) or environmental
 * issues (connectivity, auth, deleted warehouse, timeouts) that the has-types
 * gate will handle later.
 *
 * Returns:
 * - "deterministic": HTTP 404 (bad warehouse id) or 400 (malformed request).
 *   The build must fail.
 * - "environmental": Everything else — auth (401/403), connectivity errors,
 *   warehouse state changes (DELETED/DELETING), wait-for-RUNNING timeouts,
 *   unrecognized failures. Default = environmental.
 *
 * Walks `cause`/`AggregateError` chains when checking for deterministic status,
 * so a wrapped 404 is still recognized as deterministic.
 */
export function classifyBlockingFailure(
  error: unknown,
): "deterministic" | "environmental" {
  const seen = new Set<unknown>();
  const stack = [error];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    const status = getErrorStatus(current);
    if (status === 404 || status === 400) {
      return "deterministic";
    }

    stack.push(...getErrorChildren(current));
  }

  return "environmental";
}

// Databricks REST/SDK auth error codes. These arrive as an `error_code` string
// (a top-level field, or a JSON body embedded in the message) rather than a
// numeric HTTP status, so status-only detection misses them.
const AUTH_ERROR_CODES = new Set(["PERMISSION_DENIED", "UNAUTHENTICATED"]);

/**
 * Extract a Databricks `error_code` (e.g. "PERMISSION_DENIED") from a thrown
 * error. The SDK surfaces it either as a top-level `error_code` field or as a
 * JSON body embedded in the message string, e.g.
 * `Response from server (Forbidden) {"error_code":"PERMISSION_DENIED",...}`.
 */
function getDatabricksErrorCode(error: unknown): string | undefined {
  if (!isObject(error)) return undefined;
  if (typeof error.error_code === "string") return error.error_code;

  const message = typeof error.message === "string" ? error.message : undefined;
  const jsonMatch = message?.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { error_code?: unknown };
      if (typeof parsed.error_code === "string") return parsed.error_code;
    } catch {
      // not valid JSON — fall through
    }
  }
  return undefined;
}

/**
 * True when a thrown failure is an authentication/authorization problem: an
 * HTTP 401/403, or a Databricks `error_code` of PERMISSION_DENIED /
 * UNAUTHENTICATED (which can arrive with no numeric status). Walks
 * `cause`/`AggregateError` chains so a wrapped auth error is still recognized.
 *
 * Callers degrade rather than fail the build on `true`: a build-time identity
 * gap — the build runs as a different principal than the app's runtime
 * on-behalf-of user — must not block a deploy when committed types exist. The
 * has-types gate still crashes a fresh checkout with nothing to fall back to.
 */
export function isAuthError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const stack = [error];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    const status = getErrorStatus(current);
    if (status !== undefined && AUTH_ERROR_STATUSES.has(status)) return true;

    const code = getDatabricksErrorCode(current);
    if (code && AUTH_ERROR_CODES.has(code)) return true;

    stack.push(...getErrorChildren(current));
  }

  return false;
}

/**
 * Coarse cause label for an environmental failure, used by the `--wait`
 * committed-types warning so the log says *why* generation fell back.
 *
 * Returns:
 * - "unreachable": transport/connectivity failure (see {@link isConnectivityError}).
 * - "auth": HTTP 401/403 or a PERMISSION_DENIED / UNAUTHENTICATED `error_code`,
 *   including one carried on `response.status` or wrapped in a
 *   `cause`/`AggregateError` chain (see {@link isAuthError}).
 * - "unavailable": everything else (DELETED/DELETING, wait timeouts, degraded
 *   DESCRIBEs).
 */
export function classifyEnvironmentalCause(
  error: unknown,
): "auth" | "unreachable" | "unavailable" {
  if (isConnectivityError(error)) return "unreachable";
  if (isAuthError(error)) return "auth";
  return "unavailable";
}
