import type { WarehouseState } from "./warehouse-status";

/**
 * How aggressively typegen should react to a not-ready warehouse.
 *  - `non-blocking`: never describe and never probe the warehouse — emit
 *    best-available types (cache where the SQL hash matches, else `unknown`) and
 *    return at once. The default for interactive/foreground runs that can't
 *    afford to block on (or fail because of) a warehouse, even a RUNNING one.
 *  - `blocking`: a startable warehouse is worth waiting for, and a stopped one
 *    is worth starting — only a deleted/deleting warehouse is a hard failure.
 */
export type PreflightMode = "non-blocking" | "blocking";

/**
 * What the caller should do given a warehouse state and mode.
 *  - `proceed`: run DESCRIBE now.
 *  - `degradeAll`: skip DESCRIBE; emit degraded (cached/`unknown`) types.
 *  - `waitThenProceed`: wait for the warehouse to start, then run DESCRIBE.
 *  - `startWaitProceed`: start the stopped warehouse, wait for RUNNING, then
 *    run DESCRIBE.
 *  - `fatal`: stop — the warehouse can't serve this run.
 */
export type PreflightDecision =
  | "proceed"
  | "degradeAll"
  | "waitThenProceed"
  | "startWaitProceed"
  | "fatal";

/**
 * Pure policy mapping a warehouse state + mode to a preflight decision.
 *
 * Unknown/unexpected states fall through to `proceed`: the describe loop and
 * its per-query backstop already degrade gracefully, so we don't want a new
 * SDK state value to turn into a spurious `fatal`.
 */
export function decidePreflight(
  state: WarehouseState,
  mode: PreflightMode,
): PreflightDecision {
  // `non-blocking` never describes regardless of state: emit cached/`unknown`
  // types and return. The caller short-circuits before probing, so this is only
  // a belt-and-suspenders mapping, but it keeps the policy total and
  // self-contained.
  if (mode === "non-blocking") return "degradeAll";

  // `blocking`: a starting warehouse is worth waiting for, a stopped one is
  // worth starting (then waiting), and only a deleted/deleting one is fatal.
  switch (state) {
    case "RUNNING":
      return "proceed";
    case "STARTING":
      return "waitThenProceed";
    case "STOPPED":
    case "STOPPING":
      return "startWaitProceed";
    case "DELETED":
    case "DELETING":
      return "fatal";
    default:
      return "proceed";
  }
}
