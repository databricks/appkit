import type { ServiceContextState } from "./service-context";

/** The principal whose credentials authorize the execution. */
export type Principal = Readonly<{
  type: "user";
  userId: string;
  userName?: string;
  userEmail?: string;
}>;

/** Caller identity and workspace for one immutable execution scope. */
export interface CallerContext {
  readonly client: ServiceContextState["client"];
  readonly principal: Principal;
  /** Truncated SHA-256 hash of the caller token, used to detect rotation. */
  readonly tokenFingerprint?: string;
  readonly workspaceId: Promise<string>;
}

export type ExecutionContext = ServiceContextState | CallerContext;

export function isCallerContext(ctx: ExecutionContext): ctx is CallerContext {
  return "principal" in ctx && ctx.principal.type === "user";
}
