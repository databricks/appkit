import type express from "express";
import type { JSONSchema7 } from "json-schema";
import type {
  PluginManifest as GeneratedPluginManifest,
  ResourceRequirement as GeneratedResourceRequirement,
  ResourceFieldEntry,
} from "./schemas/plugin-manifest.generated";

// Re-export generated types as the shared canonical definitions.
export type { ResourceFieldEntry };

/** Base plugin interface. */
export interface BasePlugin {
  name: string;

  abortActiveOperations?(): void;

  setup(): Promise<void>;

  injectRoutes(router: express.Router): void;

  getEndpoints(): PluginEndpointMap;

  getSkipBodyParsingPaths?(): ReadonlySet<string>;

  exports?(): unknown;
}

/** Base configuration interface for AppKit plugins */
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

/**
 * Plugin constructor with required manifest declaration.
 * All plugins must declare a manifest with their metadata and resource requirements.
 */
export type PluginConstructor<
  C = BasePluginConfig,
  I extends BasePlugin = BasePlugin,
> = (new (
  config: C,
) => I) & {
  DEFAULT_CONFIG?: Record<string, unknown>;
  phase?: PluginPhase;
  /**
   * Static manifest declaring plugin metadata and resource requirements.
   * Required for all plugins.
   */
  manifest: PluginManifest;
  /**
   * Optional runtime resource requirements based on config.
   * Use this when resource requirements depend on plugin configuration.
   */
  getResourceRequirements?(config: C): ResourceRequirement[];
};

/**
 * Manifest declaration for plugins.
 * Extends the generated PluginManifest with a generic name parameter
 * and uses JSONSchema7 for config.schema (the generated ConfigSchema
 * is too restrictive for plugin consumers).
 *
 * @see {@link GeneratedPluginManifest} — generated base from plugin-manifest.schema.json
 * @see `packages/appkit/src/registry/types.ts` `PluginManifest` — strict appkit narrowing (enum types)
 */
export interface PluginManifest<TName extends string = string>
  extends Omit<
    GeneratedPluginManifest,
    "name" | "config" | "$schema" | "resources"
  > {
  name: TName;
  resources: {
    required: Omit<ResourceRequirement, "required">[];
    optional: Omit<ResourceRequirement, "required">[];
  };
  config?: {
    schema: JSONSchema7;
  };
}

/**
 * Resource requirement with runtime fields added beyond the schema definition.
 * - `fields` is made required (schema has it optional, but registry always populates it)
 * - `required` boolean tracks whether the resource is mandatory at runtime
 *
 * @see {@link GeneratedResourceRequirement} — generated base from plugin-manifest.schema.json
 * @see `packages/appkit/src/registry/types.ts` `ResourceRequirement` — strict appkit narrowing (enum types)
 */
export interface ResourceRequirement extends GeneratedResourceRequirement {
  fields: Record<string, ResourceFieldEntry>;
  required: boolean;
}

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
 * Extracts the exports type from a plugin.
 * This is the return type of the plugin's exports() method.
 * If the plugin doesn't implement exports(), returns an empty object type.
 */
export type PluginExports<T extends BasePlugin> =
  T["exports"] extends () => infer R ? R : Record<string, never>;

/**
 * Wraps an SDK with the `asUser` method that AppKit automatically adds.
 * When `asUser(req)` is called, it returns the same SDK but scoped to the user's credentials.
 *
 * When the SDK is a function (callable export), it is returned as-is since
 * the plugin manages its own `asUser` pattern per-call.
 */
export type WithAsUser<SDK> = SDK extends (...args: any[]) => any
  ? SDK
  : SDK & {
      /**
       * Execute operations using the user's identity from the request.
       * Returns a user-scoped SDK where all methods execute with the
       * user's Databricks credentials instead of the service principal.
       */
      asUser: (req: IAppRequest) => SDK;
    };

/**
 * Maps plugin names to their exported types (with asUser automatically added).
 * Each plugin exposes its public API via the exports() method,
 * and AppKit wraps it with asUser() for user-scoped execution.
 *
 * Callable exports (functions) are passed through without wrapping,
 * as they manage their own `asUser` pattern (e.g. files plugin).
 */
export type PluginMap<
  U extends readonly PluginData<PluginConstructor, unknown, string>[],
> = {
  [P in U[number] as P["name"]]: WithAsUser<
    PluginExports<InstanceType<P["plugin"]>>
  >;
};

/** Tuple of plugin class, config, and name. Created by `toPlugin()` and passed to `createApp()`. */
export type PluginData<T, U, N> = { plugin: T; config: U; name: N };
/** Factory function type returned by `toPlugin()`. Accepts optional config and returns a PluginData tuple. */
export type ToPlugin<T, U, N extends string> = (
  config?: U,
) => PluginData<T, U, N>;

/** Express router type for plugin route registration */
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
  /** When true, the server will skip JSON body parsing for this route (e.g. file uploads). */
  skipBodyParsing?: boolean;
};

/** Map of endpoint names to their full paths for a plugin */
export type PluginEndpointMap = Record<string, string>;

/** Map of plugin names to their endpoint maps */
export type PluginEndpoints = Record<string, PluginEndpointMap>;

export interface QuerySchemas {
  [key: string]: unknown;
}
