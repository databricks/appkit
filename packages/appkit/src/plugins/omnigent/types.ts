import type { BasePluginConfig } from "shared";

import type { ToolRegistry } from "../../core/agent/tools/define-tool";
import type { OmnigentMode } from "./policies";

export type { OmnigentMode } from "./policies";

export interface IOmnigentConfig extends BasePluginConfig {
  /** System instructions for every session (the bundle's `AGENTS.md`). */
  instructions?: string;
  /**
   * The app's own tools, served to every harness over the plugin's MCP
   * endpoint and run as the session's user. Same `defineTool()` entries the
   * agents plugin takes. Tools with `annotations.effect` of `write`, `update`
   * or `destructive` are gated by `ask` and `read` modes.
   */
  tools?: ToolRegistry;
  /**
   * Also serve the tools of other registered AppKit plugins (e.g. `genie`).
   * `true` for all tool providers, or a list of plugin names. Default: none.
   */
  pluginTools?: boolean | string[];
  /** Mode new sessions start in. Default `ask`. */
  defaultMode?: OmnigentMode;
  /**
   * Harnesses users may pick, out of the ones that route model calls through
   * Unity AI Gateway. Default: all of them whose CLI is installed.
   */
  harnesses?: string[];
  /** Default harness and model for new sessions. */
  defaultHarness?: string;
  defaultModel?: string;
  runtime?: {
    /** Python with `omnigent[databricks]` installed. Default: `./.venv/bin/python`. */
    python?: string;
    /** Private state directory. Default: `$TMPDIR/appkit-omnigent`. */
    home?: string;
    /** Stop a user's host after this long without requests. Default 30 min. */
    hostIdleMs?: number;
  };
}

export interface OmnigentHarness {
  id: string;
  label: string;
  /** Has its own shell, so runs sandboxed. */
  shell: boolean;
  ready: boolean | string;
}

export interface CreateSessionRequest {
  harness?: string;
  model?: string;
  mode?: OmnigentMode;
  message?: string;
  title?: string;
}

/** Runtime health, from `GET /status` and the plugin's `status()` export. */
export interface OmnigentStatus {
  ready: boolean;
  error?: string;
  /** Omnigent server version. */
  version?: string;
  /** Harnesses with their own shell run in bubblewrap. */
  sandbox: boolean;
  /** Running per-user hosts. */
  hosts: number;
  /** Model gateway counters. */
  gateway: { forwarded: number; denied: number };
}
