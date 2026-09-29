import type { BasePluginConfig } from "shared";

export interface IOmnigentConfig extends BasePluginConfig {
  /** System instructions for every session (the bundle's `AGENTS.md`). */
  instructions?: string;
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
  ready: boolean | string;
}

export interface CreateSessionRequest {
  harness?: string;
  model?: string;
  message?: string;
  title?: string;
}

/** Runtime health, from `GET /status` and the plugin's `status()` export. */
export interface OmnigentStatus {
  ready: boolean;
  error?: string;
  /** Omnigent server version. */
  version?: string;
  /** Running per-user hosts. */
  hosts: number;
  /** Model gateway counters. */
  gateway: { forwarded: number; denied: number };
}
