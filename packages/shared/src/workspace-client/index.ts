/**
 * AppKit workspace-client wrapper — the single entry point every AppKit module
 * uses to reach a Databricks SDK client. Isolates `@databricks/sdk-experimental`
 * to `./legacy.ts` so services can migrate to the modular SDK incrementally
 * behind a stable facade.
 */
export { ApiError } from "./errors";
export { createWorkspaceClient } from "./factory";
export type {
  CancellationToken,
  ClientOptions,
  GenieMessage,
  LegacyWorkspaceClient,
  Waiter,
  WorkspaceClientOptions,
} from "./legacy";
// SDK value + type re-exports so AppKit modules import them from the wrapper.
export {
  ConfigError,
  Context,
  loadConfigFile,
  Time,
  TimeUnits,
} from "./legacy";
export type { files, jobs, serving, sql, WorkspaceClient } from "./types";
