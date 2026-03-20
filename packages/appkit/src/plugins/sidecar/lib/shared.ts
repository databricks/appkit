import type { IAppRequest, IAppRouter } from "shared";
import type { ITelemetry } from "../../../telemetry/types";
import type { HealthChecker } from "../health-checker";
import type { ProcessManager } from "../process-manager";
import type { SidecarProxy } from "../proxy";
import type { StdioBridge } from "../stdio-bridge";
import type { SidecarDefinition } from "../types";

export const DEFAULT_STARTUP_TIMEOUT = 30_000;

export function extractAuthHeaders(req: IAppRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  const user = req.headers["x-forwarded-user"];
  if (typeof user === "string") headers["x-forwarded-user"] = user;
  const token = req.headers["x-forwarded-access-token"];
  if (typeof token === "string") headers["x-forwarded-access-token"] = token;
  return headers;
}

export interface PluginRouteHelpers {
  pluginName: string;
  addSkipBodyParsingPath(path: string): void;
  registerEndpoint(name: string, path: string): void;
}

export type ModeState =
  | {
      mode: "http";
      healthChecker: HealthChecker | null;
      proxy: SidecarProxy | null;
    }
  | { mode: "stdio"; stdioBridge: StdioBridge | null };

export interface SidecarInstance {
  definition: SidecarDefinition;
  processManager: ProcessManager;
  handler: ModeHandler;
  state: ModeState;
  restarting: boolean;
}

export interface ModeHandler {
  setup(
    inst: SidecarInstance,
    telemetry: ITelemetry,
    timeout: number,
  ): Promise<void>;
  startHealthChecks(inst: SidecarInstance, timeout: number): void;
  injectRoutes(
    router: IAppRouter,
    inst: SidecarInstance,
    helpers: PluginRouteHelpers,
  ): void;
  teardown(inst: SidecarInstance): void;
}
