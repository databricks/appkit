import type { BasePluginConfig } from "shared";

import type { OmnigentMode } from "./policies";
import type { OmnigentToolSource } from "./tools";

export type { OmnigentMode } from "./policies";
export type { OmnigentToolSource } from "./tools";

export interface IOmnigentConfig extends BasePluginConfig {
  /** System instructions for every session (the bundle's `AGENTS.md`). */
  instructions?: string;
  /**
   * Databricks-managed MCP servers every session can call, as the session's
   * user: Databricks SQL, Genie spaces, Unity Catalog functions, AI Search,
   * Unity Gateway MCP Services.
   */
  tools?: OmnigentToolSource[];
  /**
   * Tool names that change data, on top of the built-in ones (Databricks
   * SQL's `execute_sql`). `ask` mode pauses on them and `read` mode denies
   * them.
   */
  writeTools?: string[];
  /** Mode new sessions start in. Default `ask`. */
  defaultMode?: OmnigentMode;
  /**
   * Harnesses users may pick, out of the ones whose model calls go through
   * Unity Gateway. Default: all of them.
   */
  harnesses?: string[];
  /** Default harness and model for new sessions. */
  defaultHarness?: string;
  defaultModel?: string;
}

export interface CreateSessionRequest {
  harness?: string;
  model?: string;
  mode?: OmnigentMode;
  message?: string;
  title?: string;
}

/** From `GET /status`: whether the workspace's managed Omnigent is usable by this user. */
export interface OmnigentStatus {
  ready: boolean;
  /** Why it is not ready, e.g. the app's token lacks the `all-apis` scope. */
  error?: string;
  /** Managed Omnigent server version. */
  version?: string;
  /** Whether Databricks Sandbox hosts are available. */
  sandboxes?: boolean;
}
