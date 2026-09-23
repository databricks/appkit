import {
  type CallerContext,
  type ExecutionContext,
  isCallerContext,
} from "./caller-context";
import { warnContextDeprecation } from "./deprecation";
import type { ServiceContextState } from "./service-context";

export type { ExecutionContext } from "./caller-context";

/**
 * @deprecated Use CallerContext and its principal field. Kept for callers
 * that construct the legacy shape or read its flat identity fields.
 */
export interface UserContext {
  /** WorkspaceClient authenticated as the user */
  client: ServiceContextState["client"];
  /** The user's ID (from request headers) */
  userId: string;
  /** The user's name (from request headers) */
  userName?: string;
  /** The user's email (from `x-forwarded-email` header) */
  userEmail?: string;
  /** Truncated SHA-256 hash of the user's OBO token, used to detect token rotation */
  tokenFingerprint?: string;
  /** Promise that resolves to the warehouse ID (inherited from service context, only present when a plugin requires `SQL_WAREHOUSE` resource) */
  warehouseId?: Promise<string>;
  /** Promise that resolves to the workspace ID (inherited from service context) */
  workspaceId: Promise<string>;
  /** Flag indicating this is a user context */
  isUserContext: true;
}

/**
 * Freeze the identity snapshot while preserving deprecated property access.
 * SDK clients and promises retain their own internal lifecycle.
 */
export function immutableCallerContext(
  ctx: CallerContext,
): CallerContext & UserContext {
  const principal = Object.freeze({ ...ctx.principal });
  return Object.freeze({
    client: ctx.client,
    principal,
    tokenFingerprint: ctx.tokenFingerprint,
    warehouseId: ctx.warehouseId,
    workspaceId: ctx.workspaceId,
    get userId() {
      warnContextDeprecation(
        "UserContext.userId",
        "CallerContext.principal.userId",
      );
      return principal.userId;
    },
    get userName() {
      warnContextDeprecation(
        "UserContext.userName",
        "CallerContext.principal.userName",
      );
      return principal.userName;
    },
    get userEmail() {
      warnContextDeprecation(
        "UserContext.userEmail",
        "CallerContext.principal.userEmail",
      );
      return principal.userEmail;
    },
    get isUserContext(): true {
      warnContextDeprecation(
        "UserContext.isUserContext",
        "CallerContext.principal.type",
      );
      return true;
    },
  });
}

/** Normalize legacy inputs before opening a caller scope. */
export function toCallerContext(
  ctx: CallerContext | UserContext,
): CallerContext {
  if ("principal" in ctx) return ctx;
  return {
    client: ctx.client,
    principal: {
      type: "user",
      userId: ctx.userId,
      userName: ctx.userName,
      userEmail: ctx.userEmail,
    },
    tokenFingerprint: ctx.tokenFingerprint,
    warehouseId: ctx.warehouseId,
    workspaceId: ctx.workspaceId,
  };
}

/**
 * @deprecated Use isCallerContext. Active caller contexts retain the legacy
 * identity accessors for callers narrowed by this guard.
 */
export function isUserContext(
  ctx: ExecutionContext | UserContext,
): ctx is UserContext & Partial<CallerContext> {
  warnContextDeprecation("isUserContext", "isCallerContext");
  return "principal" in ctx
    ? isCallerContext(ctx)
    : "isUserContext" in ctx && ctx.isUserContext === true;
}
