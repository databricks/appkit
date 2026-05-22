/**
 * Allowlist of Databricks SQL Statement Execution API error codes whose
 * `error.message` is safe to forward to clients verbatim.
 *
 * Framing: each `ServiceErrorCode` value falls into one of two camps,
 * based on what wording is interpolated into `error.message` at the
 * gateway construction site:
 *
 * 1. **Designed-for-user** — the gateway interpolates a stable template
 *    string authored for end users (e.g. "DBSQL temporarily unavailable.
 *    Please try again in a few minutes.") or a DBR-stamped
 *    `errorDisplayMessage` covering the user's own SQL. These messages
 *    are *the entire point* of having an error string — hiding them
 *    forces users to debug in the dark. *Safe to passthrough.*
 *
 * 2. **Designed-for-debugging** — the gateway passes through a wrapped
 *    `ex.getMessage` or interpolates internal identifiers (orgId, unique
 *    warehouse IDs, scheduler pod names, internal column structure).
 *    These are intended for operator log inspection, not for clients.
 *    *Not safe to passthrough* (CWE-209).
 *
 * Source-of-truth construction sites for the classifications below:
 *
 * - DBR data-plane (`BAD_REQUEST`, `NOT_FOUND`, `ALREADY_EXISTS`):
 *   `sqlgateway/scheduler/src/main/scala/DriverRequests.scala:181-208`
 *   populates `ErrorInfo.withMessage(command.errorDisplayMessage)` and
 *   sets `withErrorReturnedFromDataPlane(true)`.
 *
 * - User-facing service messages (`TEMPORARILY_UNAVAILABLE`,
 *   `WORKSPACE_TEMPORARILY_UNAVAILABLE`, `SERVICE_UNDER_MAINTENANCE`):
 *   - `sqlgateway/scheduler/api/src/main/scala/client/SchedulerRpcClient.scala`
 *     constructs `SchedulerTemporarilyUnavailableException` with the
 *     literal "DBSQL temporarily unavailable. Please try again in a
 *     few minutes."
 *   - `sqlgateway/scheduler/api/src/main/scala/client/linkstore/SqlGatewayClerk.scala`
 *     constructs with `internalMessage = "DBSQL temporarily unavailable..."`
 *   - `sqlgateway/proxy/src/main/scala/thrift/Exceptions.scala`
 *     constructs `WORKSPACE_TEMPORARILY_UNAVAILABLE` from
 *     `NotServedByShardException.getMessage` — names a shard but no
 *     credentials / PII / stack traces.
 *
 * - User-actionable quota messages (`RESOURCE_EXHAUSTED`):
 *   `sqlgateway/scheduler/src/main/scala/SchedulerRpcValidatorHook.scala`
 *   emits stable templates: "The maximum number of warehouses has been
 *   reached. Please contact Databricks support.", "You've hit the limit
 *   for warehouses for free usage. Stop or delete existing warehouses
 *   to free up capacity.", etc.
 *
 * - Concurrency conflict (`ABORTED`): short reason strings like
 *   "version mismatch" (Reyden warehouse monitor). No internal context.
 *
 * - Genuinely-internal-only (`INTERNAL_ERROR`, `IO_ERROR`, `UNKNOWN`):
 *   `sqlgateway/database/src/main/scala/endpoints/EndpointModel.scala`
 *   interpolates `s"SQL ${conf.warehouse} cannot be created due to
 *   repeated collisions on unique IDs."` — exposes internal database
 *   state. `SchedulerRpcContextValidatorHook.workspaceNotOwned(orgId)`
 *   interpolates orgId. Test fixtures show stack traces interpolated
 *   into `internalMessage`. *Default-deny.*
 *
 * - `UNAUTHENTICATED` / `CANCELLED` / `DEADLINE_EXCEEDED`: SDK-level
 *   codes with generic message templates.
 *
 * SDK type reference (`@databricks/sdk-experimental`,
 * `apis/sql/model.d.ts`):
 * ```
 * type ServiceErrorCode =
 *   | "ABORTED" | "ALREADY_EXISTS" | "BAD_REQUEST" | "CANCELLED"
 *   | "DEADLINE_EXCEEDED" | "INTERNAL_ERROR" | "IO_ERROR" | "NOT_FOUND"
 *   | "RESOURCE_EXHAUSTED" | "SERVICE_UNDER_MAINTENANCE"
 *   | "TEMPORARILY_UNAVAILABLE" | "UNAUTHENTICATED" | "UNKNOWN"
 *   | "WORKSPACE_TEMPORARILY_UNAVAILABLE";
 * ```
 *
 * **Default-deny on unknown codes** — when the SDK ships a new variant
 * the allowlist hasn't been reviewed against, the new code collapses to
 * the generic clientMessage until someone audits the construction sites
 * and updates the Set below.
 */

/** ServiceErrorCode values for which `error.message` may be forwarded verbatim. */
const SAFE_PASSTHROUGH_CODES: ReadonlySet<string> = new Set([
  // DBR-authored: user's own SQL errors. Parse, semantic, type, missing
  // table/column. Examples: "Table or view 'foo' not found", "Syntax
  // error at or near ',' on line 3".
  "BAD_REQUEST",
  // DBR catalog miss — "Table 'foo' not found", "Schema 'bar' not found".
  "NOT_FOUND",
  // DBR catalog conflict — "Table 'foo' already exists".
  "ALREADY_EXISTS",
  // Stable template: "Query timed out after Ns". User-actionable.
  "DEADLINE_EXCEEDED",
  // "Statement was canceled". User/admin-initiated; no internal state.
  "CANCELLED",
  // SDK generic — "Permission denied", "Authentication required".
  "UNAUTHENTICATED",
  // Stable user-facing template: "DBSQL temporarily unavailable. Please
  // try again in a few minutes." Hiding this would force users to
  // distinguish "warehouse issue" from "user error" by guesswork.
  "TEMPORARILY_UNAVAILABLE",
  // Workspace-level service messages from shard-routing failures. The
  // message may name a shard ID — that's internal topology metadata,
  // low sensitivity, and operationally useful for the user to know
  // the workspace is in motion.
  "WORKSPACE_TEMPORARILY_UNAVAILABLE",
  // Maintenance windows — generic template messages.
  "SERVICE_UNDER_MAINTENANCE",
  // Stable user-actionable templates from the warehouse quota path:
  // "The maximum number of warehouses has been reached. Please contact
  // Databricks support.", "Stop or delete existing warehouses to free
  // up capacity.", etc. Telling users "Query execution failed" when
  // they've actually hit a quota is unhelpful.
  "RESOURCE_EXHAUSTED",
  // Concurrency conflict — short reason strings ("version mismatch",
  // "concurrent modification"). User-relevant for retry decisions.
  "ABORTED",
]);

/**
 * Explicitly NOT on the allowlist (documented for future-reviewer
 * context; classification is by absence from `SAFE_PASSTHROUGH_CODES`):
 *
 * - `INTERNAL_ERROR` — construction sites interpolate unique warehouse
 *   IDs, orgIds, and wrap `ex.getMessage` from arbitrary exceptions.
 *   Example: `s"SQL ${conf.warehouse} cannot be created due to repeated
 *   collisions on unique IDs."` (`EndpointModel.scala`). High leak risk.
 * - `IO_ERROR` — storage / network failures; messages typically include
 *   bucket names, paths, internal hostnames.
 * - `UNKNOWN` — unclassified by definition; can be anything.
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
