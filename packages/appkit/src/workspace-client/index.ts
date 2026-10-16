/**
 * AppKit workspace-client wrapper: the single entry point every AppKit module
 * uses to reach a Databricks SDK client. The modular `@databricks/sdk-*`
 * packages are isolated to `shared/workspace-client`.
 */

export { ApiError, createWorkspaceClient, isAuthConfigError } from "shared";
// Forwards every wrapper type: the facade, its options, and the modular SDK
// client + model types.
export type * from "shared/workspace-client";
