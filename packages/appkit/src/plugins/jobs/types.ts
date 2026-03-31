import type { BasePluginConfig } from "shared";

/**
 * Configuration for the Jobs plugin.
 *
 * All fields are optional — the plugin uses the workspace client
 * from AppKit's context (authenticated via DATABRICKS_HOST + token).
 */
export interface IJobsConfig extends BasePluginConfig {
  /** Default timeout for Jobs API calls in milliseconds. Defaults to 60000. */
  timeout?: number;
  /** Poll interval when waiting for run completion. Defaults to 5000ms. */
  pollIntervalMs?: number;
}
