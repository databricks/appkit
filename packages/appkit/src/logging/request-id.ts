/**
 * Shared request ID helpers used by both the plugin body-validation
 * wrapper (`plugin.ts`) and the wide-event logger (`logger.ts`) so they
 * agree on what a "valid" client-supplied `x-request-id` header looks
 * like.
 *
 * A single allowlist keeps the two paths in sync: when a request hits a
 * validation failure, the `requestId` echoed in the canonical 400
 * response matches the `request_id` recorded in the wide-event log,
 * letting operators correlate a client-visible 4xx with the full
 * server-side issue trace.
 */

/** Maximum length of a client-supplied request ID after sanitization. */
export const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Strict allowlist for incoming `x-request-id` (and equivalent
 * correlation) headers. The first character must be alphanumeric so
 * values starting with `-`, `_`, or `.` cannot be misinterpreted as
 * flags if the requestId ever flows into a shell pipeline an operator
 * runs. Subsequent characters allow URL-safe ASCII plus underscore,
 * dot, and hyphen. Capped at {@link MAX_REQUEST_ID_LENGTH} characters
 * total so client-supplied values can never contain CRLF
 * (log-injection / CWE-117) or blow up server memory.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * Validate a client-supplied request ID against the canonical allowlist.
 *
 * Returns the value unchanged if it matches; returns `undefined`
 * otherwise. Callers should generate a fresh fallback when this
 * returns `undefined` rather than attempting any normalization — the
 * helper is intentionally fail-closed so that malformed or
 * attacker-controlled values never leak into logs or response bodies.
 */
export function sanitizeRequestId(id: string): string | undefined {
  if (REQUEST_ID_PATTERN.test(id)) {
    return id;
  }
  return undefined;
}
