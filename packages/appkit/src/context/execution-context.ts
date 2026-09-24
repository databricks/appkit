import { AsyncLocalStorage } from "node:async_hooks";

import {
  captureWarehouseId,
  getWarehouseId as getResourceWarehouseId,
  runWithResourceBindings,
  type WarehouseBinding,
} from "../resources/warehouse";
import { type CallerContext, snapshotCallerContext } from "./caller-context";
import { warnContextDeprecation } from "./deprecation";
import { ServiceContext, type ServiceContextState } from "./service-context";
import {
  legacyUserContext,
  toCallerContext,
  type UserContext,
} from "./user-context";

const executionContextStorage = new AsyncLocalStorage<CallerContext>();

function runInCallerScope<T>(
  callerContext: CallerContext,
  fn: () => T,
  legacyResources?: WarehouseBinding,
): T {
  const caller = snapshotCallerContext(callerContext);
  return runWithResourceBindings(legacyResources, () =>
    executionContextStorage.run(caller, fn),
  );
}

/**
 * Run a function with an immutable snapshot of the caller context.
 * Nested and concurrent scopes keep their own identities.
 *
 * @param callerContext - The caller context to use
 * @param fn - The function to run
 * @returns The result of the function
 */
export function runInCallerContext<T>(
  callerContext: CallerContext,
  fn: () => T,
): T {
  return runInCallerScope(callerContext, fn);
}

/** @deprecated Use runInCallerContext. */
export function runInUserContext<T>(
  userContext: UserContext | (CallerContext & Pick<UserContext, "warehouseId">),
  fn: () => T,
): T {
  warnContextDeprecation("runInUserContext", "runInCallerContext");
  if (!("principal" in userContext) || "warehouseId" in userContext) {
    return runInCallerScope(
      toCallerContext(userContext),
      fn,
      Object.freeze({ warehouseId: userContext.warehouseId }),
    );
  }
  return runInCallerContext(toCallerContext(userContext), fn);
}

/**
 * Get the current execution context.
 *
 * - If running inside a caller context (via asUser), returns the caller context
 * - Otherwise, returns the service context
 *
 * @throws Error if ServiceContext is not initialized
 */
export function getExecutionContext():
  | ServiceContextState
  | (CallerContext & UserContext) {
  const callerContext = executionContextStorage.getStore();
  if (callerContext) {
    return legacyUserContext(callerContext, captureWarehouseId());
  }
  return ServiceContext.get();
}

/**
 * Get the principal key for future cache keying: `app` or `user:<id>`.
 */
export function getCurrentPrincipalKey(): string {
  const caller = getCallerContext();
  return caller ? `user:${caller.principal.userId}` : "app";
}

/** The initiating user in a caller scope; no user actor exists in service scope. */
export function getCurrentActorId(): string | undefined {
  return getCallerContext()?.principal.userId;
}

/**
 * @deprecated Use getCurrentPrincipalKey for new cache keys or getCurrentActorId
 * for audit. Preserves the bare user or service ID for existing callers.
 */
export function getCurrentUserId(): string {
  warnContextDeprecation(
    "getCurrentUserId",
    "getCurrentPrincipalKey (cache) or getCurrentActorId (audit)",
  );
  return getCurrentActorId() ?? ServiceContext.get().serviceUserId;
}

/**
 * Get the WorkspaceClient for the current execution context.
 */
export function getWorkspaceClient() {
  return (getCallerContext() ?? ServiceContext.get()).client;
}

/**
 * @deprecated Import getWarehouseId from @databricks/appkit instead of context.
 */
export function getWarehouseId(): Promise<string> {
  warnContextDeprecation(
    "context.getWarehouseId",
    "getWarehouseId() from @databricks/appkit",
  );
  return getResourceWarehouseId();
}

/**
 * Get the workspace ID promise.
 */
export function getWorkspaceId(): Promise<string> {
  return (getCallerContext() ?? ServiceContext.get()).workspaceId;
}

/**
 * Check if currently running in a user context.
 */
export function isInUserContext(): boolean {
  const ctx = executionContextStorage.getStore();
  return ctx !== undefined;
}

/**
 * Get the caller context if one is active, otherwise `undefined`.
 * Unlike `getExecutionContext()`, this does not require `ServiceContext`
 * to be initialized and never throws.
 */
export function getCallerContext(): CallerContext | undefined {
  return executionContextStorage.getStore();
}

/** @deprecated Use getCallerContext and its principal field. */
export function getUserContext(): (CallerContext & UserContext) | undefined {
  warnContextDeprecation("getUserContext", "getCallerContext");
  const scope = executionContextStorage.getStore();
  return scope ? legacyUserContext(scope, captureWarehouseId()) : undefined;
}
