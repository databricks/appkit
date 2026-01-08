import { AsyncLocalStorage } from "node:async_hooks";
import { ServiceContext } from "./service-context";
import {
  isUserContext,
  type ExecutionContext,
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
  return getExecutionContext().warehouseId;
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
