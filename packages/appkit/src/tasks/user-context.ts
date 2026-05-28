import type { TaskContext } from "../../vendor/taskflow/taskflow.js";
import type { UserContext } from "../context";

/**
 * Reads the OBO `UserContext` that AppKit forwards through
 * `ctx.context` on `executeTask`. Returns `null` for SP runs, recovery
 * without an explicit `{ context }`, or any payload that fails the
 * `isUserContext` discriminator (defends against stale / wrong-shape
 * sidecars).
 *
 * @example
 * ```ts
 * const userCtx = userContextFromTaskCtx(ctx);
 * if (userCtx) return runInUserContext(userCtx, () => doWork(input));
 * return doWork(input);
 * ```
 *
 * @public
 */
export function userContextFromTaskCtx(
  ctx: Pick<TaskContext, "context">,
): UserContext | null {
  const value = ctx.context as unknown;
  if (
    value !== null &&
    typeof value === "object" &&
    "isUserContext" in value &&
    (value as { isUserContext?: unknown }).isUserContext === true &&
    "userId" in value &&
    typeof (value as { userId?: unknown }).userId === "string"
  ) {
    return value as UserContext;
  }
  return null;
}
