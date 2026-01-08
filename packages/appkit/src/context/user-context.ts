import type { ServiceContextState } from "./service-context";

/**
 * User execution context extends the service context with user-specific data.
 * Created on-demand when asUser(req) is called.
 */
export interface UserContext {
  /** WorkspaceClient authenticated as the user */
  client: ServiceContextState["client"];
  /** The user's ID (from request headers) */
  userId: string;
  /** The user's name (from request headers) */
  userName?: string;
  /** Promise that resolves to the warehouse ID (inherited from service context) */
  warehouseId: Promise<string>;
  /** Promise that resolves to the workspace ID (inherited from service context) */
  workspaceId: Promise<string>;
  /** Flag indicating this is a user context */
  isUserContext: true;
}

/**
 * Execution context can be either service or user context.
 */
export type ExecutionContext = ServiceContextState | UserContext;

/**
 * Check if an execution context is a user context.
 */
export function isUserContext(ctx: ExecutionContext): ctx is UserContext {
  return "isUserContext" in ctx && ctx.isUserContext === true;
}
