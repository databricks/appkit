import type { WarehouseState } from "./warehouse-status";

/**
 * How aggressively typegen should react to a not-ready warehouse.
 *  - `dev`: never block the developer; degrade to `unknown`/cached types, but a
 *    RUNNING warehouse is still described (fast path / background fire-and-forget).
 *  - `blocking`: a startable warehouse is worth waiting for, and a stopped one
 *    is a hard failure.
 *  - `degrade`: never describe and never probe the warehouse — emit best-available
 *    types (cache where the SQL hash matches, else `unknown`) and return at once.
 *    For a one-shot CLI (`--no-block`) that can't describe in the background.
 */
export type PreflightMode = "dev" | "blocking" | "degrade";

/**
 * What the caller should do given a warehouse state and mode.
 *  - `proceed`: run DESCRIBE now.
 *  - `degradeAll`: skip DESCRIBE; emit degraded (cached/`unknown`) types.
 *  - `waitThenProceed`: wait for the warehouse to start, then run DESCRIBE.
 *  - `fatal`: stop — the warehouse can't serve this run.
 */
export type PreflightDecision =
  | "proceed"
  | "degradeAll"
  | "waitThenProceed"
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
  // `degrade` never describes regardless of state: emit cached/`unknown` types
  // and return. The caller short-circuits before probing, so this is only a
  // belt-and-suspenders mapping, but it keeps the policy total and self-contained.
  if (mode === "degrade") return "degradeAll";

  switch (state) {
    case "RUNNING":
      return "proceed";
    case "STARTING":
      return mode === "blocking" ? "waitThenProceed" : "degradeAll";
    case "STOPPED":
    case "STOPPING":
      return mode === "blocking" ? "fatal" : "degradeAll";
    case "DELETED":
    case "DELETING":
      return "fatal";
    default:
      return "proceed";
  }
}
