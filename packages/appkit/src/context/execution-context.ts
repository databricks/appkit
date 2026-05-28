import { AsyncLocalStorage } from "node:async_hooks";
import { ConfigurationError } from "../errors";
import { ServiceContext } from "./service-context";
import {
  type ExecutionContext,
  isUserContext,
  type UserContext,
} from "./user-context";

/**
 * AsyncLocalStorage for execution context.
 * Used to pass user context through the call stack without explicit parameters.
 */
const executionContextStorage = new AsyncLocalStorage<UserContext>();

/**
 * Run a function in the context of a user.
 * All calls within the function will have access to the user context.
 *
 * @param userContext - The user context to use
 * @param fn - The function to run
 * @returns The result of the function
 */
export function runInUserContext<T>(userContext: UserContext, fn: () => T): T {
  return executionContextStorage.run(userContext, fn);
}

/**
 * Get the current execution context.
 *
 * - If running inside a user context (via asUser), returns the user context
 * - Otherwise, returns the service context
 *
 * @throws Error if ServiceContext is not initialized
 */
export function getExecutionContext(): ExecutionContext {
  const userContext = executionContextStorage.getStore();
  if (userContext) {
    return userContext;
  }
  return ServiceContext.get();
}

/**
 * Get the current user ID for cache keying and telemetry.
 *
 * Returns the user ID if in user context, otherwise the service user ID.
 */
export function getCurrentUserId(): string {
  const ctx = getExecutionContext();
  if (isUserContext(ctx)) {
    return ctx.userId;
  }
  return ctx.serviceUserId;
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
 * Check if currently running in a user context. Sugar for
 * `getCurrentUserContext() !== null` — prefer {@link getCurrentUserContext}
 * when you also need the value.
 */
export function isInUserContext(): boolean {
  return getCurrentUserContext() !== null;
}

/**
 * Returns the active {@link UserContext} when inside a
 * `runInUserContext` scope (set by `plugin.asUser(req).method(...)`),
 * or `null`. Use to forward user identity to a downstream layer
 * (e.g. spawning a durable task that should run as the caller).
 */
export function getCurrentUserContext(): UserContext | null {
  return executionContextStorage.getStore() ?? null;
}

/**
 * Get the user context if one is active, otherwise `undefined`.
 * Unlike `getExecutionContext()`, this does not require `ServiceContext`
 * to be initialized and never throws.
 */
export function getUserContext(): UserContext | undefined {
  return executionContextStorage.getStore();
}
