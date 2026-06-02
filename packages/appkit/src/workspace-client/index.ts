/**
 * AppKit workspace-client wrapper. Single entry point used by every other
 * AppKit module that needs a Databricks SDK client.
 *
 * See `./types.ts` for the wrapper interface and the per-service migration
 * status, and the PoC plan in the repo root for the broader context.
 */
export { ApiError, getApiErrorStatusCode, isApiError } from "./errors";
export type { WorkspaceClientOptions } from "./factory";
export { createWorkspaceClient } from "./factory";
// AppKitHttpClient is referenced internally via `WorkspaceClient.http` —
// no need to re-export the class type itself (knip flagged it as unused).
export type { RawResponse, RequestOptions } from "./http";
export type { files, jobs, serving, sql, WorkspaceClient } from "./types";
