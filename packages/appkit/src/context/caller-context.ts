import type { ServiceContextState } from "./service-context";
import type { UserContext } from "./user-context";

/** The caller identity whose permissions authorize execution, not its resources. */
export type CallerPrincipal = Readonly<{
  type: "user";
  userId: string;
  userName?: string;
  userEmail?: string;
}>;

/** @deprecated Use CallerPrincipal. Retained for backward compatibility. */
export type Principal = CallerPrincipal;

/** Caller identity and workspace for one immutable execution scope. */
export interface CallerContext {
  readonly client: ServiceContextState["client"];
  readonly principal: CallerPrincipal;
  /** Truncated SHA-256 hash of the caller token, used to detect rotation. */
  readonly tokenFingerprint?: string;
  readonly workspaceId: Promise<string>;
  /** @deprecated Use getWarehouseId(). Only legacy context access exposes this field. */
  readonly warehouseId?: Promise<string>;
}

const snapshots = new WeakSet<CallerContext>();

/** Snapshot identity without freezing the SDK client's internal lifecycle. */
export function snapshotCallerContext(ctx: CallerContext): CallerContext {
  if (snapshots.has(ctx)) return ctx;
  const snapshot = Object.freeze({
    client: ctx.client,
    principal: Object.freeze({ ...ctx.principal }),
    tokenFingerprint: ctx.tokenFingerprint,
    workspaceId: ctx.workspaceId,
  });
  snapshots.add(snapshot);
  return snapshot;
}

export type ExecutionContext =
  | ServiceContextState
  | CallerContext
  | UserContext;

export function isCallerContext(ctx: ExecutionContext): ctx is CallerContext {
  return "principal" in ctx && ctx.principal.type === "user";
}
