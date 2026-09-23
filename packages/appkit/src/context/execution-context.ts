import { AsyncLocalStorage } from "node:async_hooks";

import { ConfigurationError } from "../errors";
import {
  type CallerContext,
  type ExecutionContext,
  isCallerContext,
} from "./caller-context";
import { warnContextDeprecation } from "./deprecation";
import { ServiceContext } from "./service-context";
import {
  immutableCallerContext,
  toCallerContext,
  type UserContext,
} from "./user-context";

/**
 * AsyncLocalStorage for execution context.
 * Used to pass caller context through the call stack without explicit parameters.
 */
const executionContextStorage = new AsyncLocalStorage<
  CallerContext & UserContext
>();

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
  return executionContextStorage.run(immutableCallerContext(callerContext), fn);
}

/** @deprecated Use runInCallerContext. */
export function runInUserContext<T>(
  userContext: UserContext | CallerContext,
  fn: () => T,
): T {
  warnContextDeprecation("runInUserContext", "runInCallerContext");
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
export function getExecutionContext(): ExecutionContext {
  const callerContext = executionContextStorage.getStore();
  if (callerContext) {
    return callerContext;
  }
  return ServiceContext.get();
}

/**
 * Get the principal key for future cache keying: `app` or `user:<id>`.
 */
export function getCurrentPrincipalKey(): string {
  const ctx = getExecutionContext();
  return isCallerContext(ctx) ? `user:${ctx.principal.userId}` : "app";
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
  return getExecutionContext().client;
}

/**
 * Get the warehouse ID promise.
 */
export function getWarehouseId(): Promise<string> {
  const ctx = getExecutionContext();
  if (!ctx.warehouseId) {
    throw ConfigurationError.resourceNotFound(
      "Warehouse ID",
      "No plugin requires a SQL Warehouse. Add a sql_warehouse resource to your plugin manifest, or set DATABRICKS_WAREHOUSE_ID",
    );
  }
  return ctx.warehouseId;
}

/**
 * Get the workspace ID promise.
 */
export function getWorkspaceId(): Promise<string> {
  return getExecutionContext().workspaceId;
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
  return executionContextStorage.getStore();
}
