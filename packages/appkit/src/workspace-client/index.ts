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
// Forwards every wrapper type — legacy service namespaces (files/jobs/serving),
// the client option/waiter types, and the modular SDK client + model types
// (warehouses, statementExecution). `sql` is gone: its statement + warehouse
// types now come from the modular SDK.
export type * from "shared/workspace-client";
