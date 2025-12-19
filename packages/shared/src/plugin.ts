import type express from "express";

export interface BasePlugin {
  name: string;

  abortActiveOperations?(): void;

  validateEnv(): void;

  setup(): Promise<void>;

  injectRoutes(router: express.Router): void;

  getEndpoints(): PluginEndpointMap;
}

export interface BasePluginConfig {
  name?: string;
  host?: string;

  [key: string]: unknown;

  /*
   * Telemetry configuration
   * @default true for all telemetry types
   */
  telemetry?: TelemetryOptions;
}

export type TelemetryOptions =
  | boolean
  | {
      traces?: boolean;
      metrics?: boolean;
      logs?: boolean;
    };

export interface PluginConfig {
  config?: unknown;
  plugin: PluginConstructor;
}

export type PluginPhase = "core" | "normal" | "deferred";

export type PluginConstructor<
  C = BasePluginConfig,
  I extends BasePlugin = BasePlugin,
> = (new (
  config: C,
) => I) & {
  DEFAULT_CONFIG?: Record<string, unknown>;
  phase?: PluginPhase;
};

export type ConfigFor<T> = T extends { DEFAULT_CONFIG: infer D }
  ? D
  : T extends new (
        ...args: any[]
      ) => { config: infer C }
    ? C
    : BasePluginConfig;

// Optional config plugin definition (used internally)
export type OptionalConfigPluginDef<P extends PluginConstructor> = {
  plugin: P;
  config?: Partial<ConfigFor<P>>;
};

// Input plugin map type (used internally by AppKit)
export type InputPluginMap = {
  [key: string]: OptionalConfigPluginDef<PluginConstructor> | undefined;
};

// AppKit with plugins - extracts instances from plugin map
export type AppKitWithPlugins<T extends InputPluginMap> = {
  [K in keyof T]: T[K] extends {
    plugin: PluginConstructor<BasePluginConfig, infer I>;
  }
    ? I
    : never;
};

export type PluginMap<
  U extends readonly PluginData<PluginConstructor, unknown, string>[],
> = {
  [P in U[number] as P["name"]]: InstanceType<P["plugin"]>;
};

export type PluginData<T, U, N> = { plugin: T; config: U; name: N };
export type ToPlugin<T, U, N extends string> = (
  config?: U,
) => PluginData<T, U, N>;

export type IAppRouter = express.Router;
export type IAppResponse = express.Response;
export type IAppRequest = express.Request;

export type HttpMethod = "get" | "post" | "put" | "delete" | "patch" | "head";

export type RouteConfig = {
  /** Unique name for this endpoint (used for frontend access) */
  name: string;
  method: HttpMethod;
  path: string;
  handler: (req: IAppRequest, res: IAppResponse) => Promise<void>;
};

/** Map of endpoint names to their full paths for a plugin */
export type PluginEndpointMap = Record<string, string>;

/** Map of plugin names to their endpoint maps */
export type PluginEndpoints = Record<string, PluginEndpointMap>;

export interface QuerySchemas {
  [key: string]: unknown;
}
