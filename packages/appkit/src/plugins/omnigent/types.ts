import type { BasePluginConfig } from "shared";

export interface IOmnigentConfig extends BasePluginConfig {
  /** System instructions for every session (the bundle's `AGENTS.md`). */
  instructions?: string;
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
