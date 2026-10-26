/**
 * AppKit workspace-client wrapper: the single entry point every AppKit module
 * uses to reach a Databricks SDK client. The modular `@databricks/sdk-*`
 * packages are isolated to this directory.
 */
export { ApiError } from "./errors";
export { createWorkspaceClient } from "./factory";
export { isAuthConfigError, ModularApiError, resolveProfile } from "./modular";
export type { ClientOptions, WorkspaceClientOptions } from "./options";
export type { WorkspaceClient } from "./types";
// Modular SDK client + model types.
export type * from "./modular";
