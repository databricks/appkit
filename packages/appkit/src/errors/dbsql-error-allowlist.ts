/**
 * Allowlist of Databricks SQL Statement Execution API error codes whose
 * `error.message` is safe to forward to clients verbatim.
 *
 * Background — the warehouse populates `error.message` from two distinct
 * sources, distinguishable only by `error.error_code`:
 *
 * 1. **DBR (data plane)** sets `errorDisplayMessage` for user-authored
 *    SQL errors (parse, semantic, type, missing-table) and surfaces them
 *    via the gateway untouched. These messages are inherently user-facing
 *    — they reference the user's own SQL — and were filtered through
 *    DBR's Thrift layer with the express purpose of being shown back to
 *    the user. They are *safe to passthrough*.
 *
 *    Source of truth: DBR -> SQL Gateway scheduler
 *    `sqlgateway/scheduler/src/main/scala/DriverRequests.scala:181-208`
 *    populates `ErrorInfo.withMessage(command.errorDisplayMessage)` and
 *    sets `withErrorReturnedFromDataPlane(true)` for these.
 *
 * 2. **Control plane (proxy / scheduler / metaservice)** sets
 *    `error.message` from internal RPC failures, scheduler exceptions,
 *    capacity rejections, etc. These messages can include correlation
 *    IDs, internal pod / service names, stack traces, and storage paths
 *    — they are *not safe to passthrough* (CWE-209).
 *
 *    Source: `sqlgateway/scheduler/src/main/scala/utils/CommandUtils.scala`
 *    and `exceptions.scala` wrap internal failures with
 *    `CommandExecutionFailed`.
 *
 * The mapping below classifies each `ServiceErrorCode` value from
 * `@databricks/sdk-experimental` (`apis/sql/model.d.ts`) by which source
 * dominates in practice. When the SDK adds a new code, default it to
 * `false` here so it stays out of the passthrough until reviewed.
 *
 * SDK type reference:
 * ```
 * type ServiceErrorCode =
 *   | "ABORTED" | "ALREADY_EXISTS" | "BAD_REQUEST" | "CANCELLED"
 *   | "DEADLINE_EXCEEDED" | "INTERNAL_ERROR" | "IO_ERROR" | "NOT_FOUND"
 *   | "RESOURCE_EXHAUSTED" | "SERVICE_UNDER_MAINTENANCE"
 *   | "TEMPORARILY_UNAVAILABLE" | "UNAUTHENTICATED" | "UNKNOWN"
 *   | "WORKSPACE_TEMPORARILY_UNAVAILABLE";
 * ```
 */

/** ServiceErrorCode values for which `error.message` may be forwarded verbatim. */
const SAFE_PASSTHROUGH_CODES: ReadonlySet<string> = new Set([
  // User-authored SQL errors flow through DBR's errorDisplayMessage.
  // Examples: "Table or view 'foo' not found", "Syntax error at or near
  // ',' on line 3", "Cannot resolve column 'col_x' given input columns".
  "BAD_REQUEST",
  // Catalog lookup misses — "Table 'foo' not found", "Schema 'bar' not
  // found". DBR sets these via the catalog layer; messages reference
  // the user's own SQL.
  "NOT_FOUND",
  // Catalog conflicts — "Table 'foo' already exists". Same provenance.
  "ALREADY_EXISTS",
  // Query timeout. Message is typically "Query timed out after Ns" —
  // user-actionable, no internal state.
  "DEADLINE_EXCEEDED",
  // Client / admin cancellation. Message is "Statement was canceled".
  "CANCELLED",
  // Authentication failures don't carry internal state; the SDK surfaces
  // a generic "Permission denied" or "Authentication required" string.
  "UNAUTHENTICATED",
]);

/**
 * Codes that explicitly carry internal control-plane wording and must
 * NEVER pass through to clients. Listed for documentation; classification
 * is by absence from `SAFE_PASSTHROUGH_CODES`.
 *
 * - `INTERNAL_ERROR` — control-plane stack traces, RPC failures.
 * - `IO_ERROR` — storage / network paths (may leak bucket names, pod IPs).
 * - `UNKNOWN` — by definition unclassified; default-deny.
 * - `RESOURCE_EXHAUSTED` — mixed; control plane sometimes leaks
 *   internal load data ("scheduler-pod-3 at 92% CPU"). Default-deny.
 * - `SERVICE_UNDER_MAINTENANCE` / `TEMPORARILY_UNAVAILABLE` /
 *   `WORKSPACE_TEMPORARILY_UNAVAILABLE` — typically generic, but the
 *   gateway has been observed to include workspace identifiers and
 *   scheduler pod names. Default-deny.
 * - `ABORTED` — server-side abort; can carry transaction / lock context
 *   identifying internal locking subsystems. Default-deny.
 */

/**
 * Returns true when the given upstream `error_code` belongs to the
 * passthrough allowlist — i.e. the corresponding `error.message` was
 * authored by DBR for the user's own SQL and is safe to forward.
 *
 * Returns false (default-deny) for any unrecognized code, including
 * codes added to the SDK after this allowlist was last reviewed.
 */
export function isSqlErrorPassthrough(errorCode: string | undefined): boolean {
  if (!errorCode) return false;
  return SAFE_PASSTHROUGH_CODES.has(errorCode);
}
