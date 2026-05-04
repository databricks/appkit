/**
 * Shared request ID helpers used by both the plugin body-validation
 * wrapper (`plugin.ts`) and the wide-event logger (`logger.ts`) so they
 * agree on what a "valid" client-supplied correlation header looks
 * like and which header(s) to consult.
 *
 * A single allowlist plus a single header lookup keeps the two paths in
 * sync: when a request hits a validation failure, the `requestId`
 * echoed in the canonical 400 response matches the `request_id`
 * recorded in the wide-event log, letting operators correlate a
 * client-visible 4xx with the full server-side issue trace.
 */

import { randomBytes } from "node:crypto";

/**
 * Per-request memoization of the resolved correlation ID.
 *
 * Multiple call sites (the wide-event logger and the body-validation
 * wrapper's 400/500 paths) all call {@link resolveRequestId} on the same
 * request. When no valid correlation header is present each call would
 * otherwise generate a new random fallback — defeating the unification
 * promised by this module. A `WeakMap` keyed on the request object
 * caches the first resolution so all subsequent calls return the same
 * ID. The map is `WeakMap`-keyed so entries are reclaimed when the
 * request is garbage-collected.
 */
const resolvedIdByRequest = new WeakMap<object, string>();

/**
 * Extract the `Root=...` segment from an AWS X-Ray header value.
 *
 * Real AWS X-Amzn-Trace-Id values look like
 * `Root=1-5759e988-bd862e3fe1be46a994272793;Parent=...;Sampled=1`. The
 * raw value contains `=` and `;` which are intentionally rejected by
 * {@link REQUEST_ID_PATTERN}, so without this extractor the
 * x-amzn-trace-id consultation in {@link resolveRequestId} would never
 * succeed for production AWS traffic. The Root segment alone is
 * allowlist-safe (alphanumeric + `-`).
 *
 * Returns `undefined` if no Root segment is found.
 */
function extractAwsTraceRoot(raw: string): string | undefined {
  for (const segment of raw.split(";")) {
    const trimmed = segment.trim();
    if (trimmed.startsWith("Root=")) {
      return trimmed.slice("Root=".length);
    }
  }
  return undefined;
}

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
 * Ordered list of headers consulted to derive a request correlation ID.
 *
 * The order matches the historical wide-event logger lookup so that any
 * value the logger would have used for `request_id` is the same value
 * the body-validation wrapper echoes back in canonical 4xx/5xx
 * responses. Adding new headers here updates both call sites
 * simultaneously.
 */
export const REQUEST_ID_HEADERS: ReadonlyArray<string> = [
  "x-request-id",
  "x-correlation-id",
  "x-amzn-trace-id",
];

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

/**
 * Resolve a request correlation ID by consulting
 * {@link REQUEST_ID_HEADERS} in order, taking the first value that
 * passes {@link sanitizeRequestId}. Returns a freshly generated fallback
 * (`req_<16 hex chars>`) when no header is present or all values are
 * malformed.
 *
 * The fallback uses 16 hex characters (~64 bits of entropy) so birthday
 * collisions stay astronomically unlikely while keeping IDs short
 * enough to skim in logs. Invalid header values are silently discarded
 * — they are never logged or reflected anywhere — so attacker-supplied
 * payloads cannot leak via this path.
 *
 * The result is memoized per-request: repeat calls on the same request
 * object always return the same ID, so the wide-event logger's
 * `request_id` and the body-validation wrapper's response `requestId`
 * stay in lockstep even when no correlation header is supplied.
 *
 * The `x-amzn-trace-id` header is special-cased: real AWS values
 * include `=` and `;`, which are rejected by the strict allowlist
 * {@link REQUEST_ID_PATTERN}. The `Root=` segment is parsed out before
 * sanitization so AWS-deployed callers actually benefit from the
 * x-amzn-trace-id consultation.
 */
export function resolveRequestId(req: {
  header(name: string): string | undefined;
}): string {
  const cached = resolvedIdByRequest.get(req);
  if (cached !== undefined) {
    return cached;
  }

  let resolved: string | undefined;
  for (const headerName of REQUEST_ID_HEADERS) {
    const raw = req.header(headerName);
    if (typeof raw !== "string" || raw.length === 0) {
      continue;
    }
    const candidate =
      headerName === "x-amzn-trace-id"
        ? (extractAwsTraceRoot(raw) ?? raw)
        : raw;
    const sanitized = sanitizeRequestId(candidate);
    if (sanitized !== undefined) {
      resolved = sanitized;
      break;
    }
  }

  // 16 hex chars = 8 random bytes = ~64 bits of entropy. Generated
  // directly so the result is exactly 16 hex chars (no embedded UUID
  // hyphens) and avoids the allocate-full-UUID-then-slice waste.
  const id = resolved ?? `req_${randomBytes(8).toString("hex")}`;
  resolvedIdByRequest.set(req, id);
  return id;
}
