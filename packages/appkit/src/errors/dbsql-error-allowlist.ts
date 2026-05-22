/**
 * Allowlist of Databricks SQL Statement Execution API error codes whose
 * `error.message` is safe to forward to clients verbatim.
 *
 * Threat model — the recipient of these messages is an *authenticated
 * workspace user*, not an anonymous internet visitor. They already know
 * the workspace URL, their orgId, their session token, the warehouses
 * they have grants on, and the catalog contents they can see. Names of
 * resources within the workspace, internal correlation IDs, and class
 * names from Databricks-internal packages are not new information to
 * this audience — the classic CWE-209 "stack-trace-on-500-page-leaks-
 * to-attacker" scenario does not apply.
 *
 * Given that, the bar for passthrough is: does the message help the
 * user (or their support contact) understand and act on the failure?
 * Defaults skew toward yes because:
 *
 * - The cost of denial is *certain* (every error becomes "Query
 *   execution failed" with no signal; users open tickets, support has
 *   to reproduce or grep server logs to find the actual error).
 * - The cost of allowing is *speculative* — depends on whatever the
 *   most recent wrapped exception happened to put in its `.toString()`.
 *
 * Server-side, the route handlers always `logger.error(rawMsg)` the
 * full upstream text before sanitization — operators retain complete
 * visibility regardless of what reaches the wire. SSE error frames
 * also carry a `requestId` (the SSE event id) so users can quote it
 * in support tickets and staff can grep logs against it directly.
 *
 * **Currently denied**: `UNKNOWN` only — by definition unclassified,
 * so we can't reason about its contents and a default-deny is the
 * minimum safe stance. Every other `ServiceErrorCode` variant is on
 * the allowlist below with a documented rationale.
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
 * - `INTERNAL_ERROR` / `IO_ERROR`:
 *   `sqlgateway/database/src/main/scala/endpoints/EndpointModel.scala`
 *   interpolates `s"SQL ${conf.warehouse} cannot be created due to
 *   repeated collisions on unique IDs."`;
 *   `SchedulerRpcContextValidatorHook.workspaceNotOwned(orgId)`
 *   interpolates orgId. These identifiers are not sensitive to a
 *   workspace user (they own / can list both). The wrapped
 *   `ex.getMessage` content is unbounded but for the typical case is
 *   either operational (RPC timeout, lock contention) or shape-of-error
 *   information the user needs to act. Allowlisted with the requestId
 *   plumbing as the safety net for triage. *Not* allowlisted if a
 *   future review finds construction sites that interpolate user
 *   credentials, OAuth tokens, or other secrets — open an issue + flip
 *   the entry.
 *
 * - `UNKNOWN`: unclassified by definition. We have no way to reason
 *   about its contents — could be anything from "RPC connect failed"
 *   to a panic dump from an upstream library. Default-deny is the
 *   only defensible stance until the SDK gives us a finer code.
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
  // Wrapped internal exceptions. Construction sites interpolate
  // workspace-internal identifiers (warehouse names, orgIds) and
  // `ex.getMessage` from arbitrary causes. To an authenticated
  // workspace user these identifiers are not sensitive — they can
  // already enumerate them. The wrapped `ex.getMessage` content is
  // unbounded but in practice is operational ("RPC timed out",
  // "deadlock detected") or shape-of-failure detail the user needs to
  // act on. The `requestId` we emit on the SSE error frame is the
  // safety net for unhappy cases — users can quote it in tickets and
  // staff can grep logs against it for the full unsanitized message.
  "INTERNAL_ERROR",
  // Storage / network failures. Same logic as INTERNAL_ERROR: path /
  // bucket names visible to a workspace user with catalog access are
  // not new information, and the wrapped error text usually tells
  // them whether to retry, switch warehouses, or escalate.
  "IO_ERROR",
]);

/**
 * Explicitly NOT on the allowlist (documented for future-reviewer
 * context; classification is by absence from `SAFE_PASSTHROUGH_CODES`):
 *
 * - `UNKNOWN` — unclassified by definition; could be anything from a
 *   library panic to an unhandled `case` in the gateway. Default-deny
 *   is the only defensible stance until the SDK gives us a finer code.
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
