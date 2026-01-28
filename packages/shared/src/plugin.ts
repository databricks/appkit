import type express from "express";

export interface BasePlugin {
  name: string;

  _abortActiveOperations?(): void;

  _validateEnv(): void;

  _setup(): Promise<void>;

  _injectRoutes(router: express.Router): void;

  _getEndpoints(): PluginEndpointMap;
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

/**
 * Keys that should be excluded from the public plugin API.
 * - `_${string}` - Convention for private/internal methods
 */
type InternalPluginKeys = `_${string}`;

/**
 * Extracts the public API from a plugin instance by filtering out:
 * - Methods starting with underscore (_)
 */
export type PublicPluginAPI<T> = {
  [K in keyof T as K extends InternalPluginKeys ? never : K]: T[K];
};

/**
 * Plugin API scoped to a user context (returned by asUser()).
 * Same as PublicPluginAPI but also excludes `asUser` to prevent chaining.
 */
export type UserScopedPluginAPI<T> = Omit<PublicPluginAPI<T>, "asUser">;

export type PluginMap<
  U extends readonly PluginData<PluginConstructor, unknown, string>[],
> = {
  [P in U[number] as P["name"]]: PublicPluginAPI<InstanceType<P["plugin"]>>;
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
