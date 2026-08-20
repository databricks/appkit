/**
 * AppKit workspace-client wrapper — the single entry point every AppKit module
 * uses to reach a Databricks SDK client. Isolates `@databricks/sdk-experimental`
 * to `./legacy.ts` so services can migrate to the modular SDK incrementally
 * behind a stable facade.
 */

export {
  ApiError,
  ConfigError,
  Context,
  createWorkspaceClient,
  Time,
  TimeUnits,
} from "shared";
export type {
  CancellationToken,
  ClientOptions,
  files,
  GenieMessage,
  jobs,
  serving,
  sql,
  Waiter,
  WorkspaceClient,
  WorkspaceClientOptions,
} from "shared/workspace-client";
