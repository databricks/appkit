/**
 * Public factory for constructing a wrapper instance from the same
 * config shape AppKit has always used.
 */
import { AppKitWorkspaceClient } from "./client";
import type { WorkspaceClientOptions } from "./legacy";
import type { WorkspaceClient } from "./types";

export type { WorkspaceClientOptions } from "./legacy";

/**
 * Construct an AppKit workspace client.
 *
 * Auth resolution:
 *   - If `opts.token` is set, uses PAT credentials.
 *   - Otherwise, walks the SDK default auth chain (env vars +
 *     ~/.databrickscfg).
 *
 * Host resolution:
 *   - Explicit `opts.host` → use it.
 *   - Otherwise `DATABRICKS_HOST` env var.
 *   - Otherwise the legacy client's resolved host (lazy fallback).
 */
export function createWorkspaceClient(
  opts: WorkspaceClientOptions,
): WorkspaceClient {
  return new AppKitWorkspaceClient(opts);
}
