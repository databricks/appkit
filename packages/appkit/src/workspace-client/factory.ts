/**
 * Public factory for constructing a wrapper instance.
 */
import { AppKitWorkspaceClient } from "./client";
import type { WorkspaceClientOptions } from "./legacy";
import type { WorkspaceClient } from "./types";

/**
 * Construct an AppKit workspace client.
 *
 * Auth resolution:
 *   - If `opts.token` is set, uses PAT credentials.
 *   - Otherwise walks the SDK default auth chain (env vars + ~/.databrickscfg).
 *
 * Host resolution:
 *   - Explicit `opts.host` → use it.
 *   - Otherwise resolved by the SDK from `DATABRICKS_HOST` / profile.
 */
export function createWorkspaceClient(
  opts: WorkspaceClientOptions = {},
): WorkspaceClient {
  return new AppKitWorkspaceClient(opts);
}
