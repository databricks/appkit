export type {
  BasePluginConfig,
  IAppRouter,
  SQLTypeMarker,
  StreamExecutionSettings,
} from "shared";
export {
  isSQLTypeMarker,
  sql,
} from "shared";
export { analytics } from "./analytics";
export { CacheManager } from "./cache";
export {
  ServiceContext,
  getExecutionContext,
  getCurrentUserId,
  getWorkspaceClient,
  getWarehouseId,
  getWorkspaceId,
  isInUserContext,
  type ExecutionContext,
  type IServiceContext,
  type IUserContext,
} from "./context";
export { createApp } from "./core";
export { Plugin, toPlugin } from "./plugin";
export { server } from "./server";
export type { ITelemetry } from "./telemetry";
export {
  type Counter,
  type Histogram,
  SeverityNumber,
  type Span,
  SpanStatusCode,
} from "./telemetry";
export { appKitTypesPlugin } from "./type-generator/vite-plugin";

/**
 * @deprecated Use getExecutionContext() from "./context" instead.
 * This export is kept for backward compatibility.
 */
export { getRequestContext } from "./utils";
