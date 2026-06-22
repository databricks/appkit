import { createContextKey, context as otelContext } from "@opentelemetry/api";
import type express from "express";
import type {
  BasePlugin,
  BasePluginConfig,
  IAppResponse,
  PluginEndpointMap,
  PluginExecuteConfig,
  PluginExecutionSettings,
  PluginPhase,
  RouteConfig,
  StreamExecuteHandler,
  StreamExecutionSettings,
} from "shared";
import { AppManager } from "../app";
import { CacheManager } from "../cache";
import { getCurrentUserId, runInUserContext, ServiceContext } from "../context";
import type { PluginContext } from "../core/plugin-context";
import { AppKitError, AuthenticationError } from "../errors";
import { createLogger } from "../logging/logger";
import { StreamManager } from "../stream";
import {
  type ITelemetry,
  normalizeTelemetryOptions,
  TelemetryManager,
} from "../telemetry";
import { deepMerge } from "../utils";
import { DevFileReader } from "./dev-reader";
import type { ExecutionResult } from "./execution-result";
import { CacheInterceptor } from "./interceptors/cache";
import { RetryInterceptor } from "./interceptors/retry";
import { TelemetryInterceptor } from "./interceptors/telemetry";
import { TimeoutInterceptor } from "./interceptors/timeout";
import type {
  ExecutionInterceptor,
  InterceptorContext,
} from "./interceptors/types";

const logger = createLogger("plugin");

/**
 * OTel context key for marking OBO dev mode fallback.
 * Set when asUser() is called in development mode without a user token.
 */
const DEV_OBO_FALLBACK_KEY = createContextKey("appkit.devOboFallback");

/**
 * Returns true if `value` is a plain object literal (not an array, Date,
 * class instance, etc.). Used to decide whether to recurse into nested
 * export shapes when wrapping functions.
 *
 * @internal exported so the AppKit core can reuse the same predicate for
 * its `bindExportMethods` walk; not part of the public package surface.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Returns a deep copy of `exports` where every function has been replaced
 * with `wrap(fn)`, walking into nested plain objects.
 *
 * Used by the asUser proxy to make the user context follow function
 * references that escape the proxy via `exports()`. The original input is
 * not mutated, so plugins that memoize `exports()` are safe — each call
 * through the proxy yields an independent, freshly wrapped view.
 */
function wrapExportFunctions(
  exports: Record<string, unknown>,
  wrap: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => unknown,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(exports)) {
    const val = exports[key];
    if (typeof val === "function") {
      result[key] = wrap(val as (...a: unknown[]) => unknown);
    } else if (isPlainObject(val)) {
      result[key] = wrapExportFunctions(val, wrap);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Returns true if the current execution is an OBO dev mode fallback
 * (asUser() was called but fell back to service principal due to missing token).
 */
export function isDevOboFallback(): boolean {
  return otelContext.active().getValue(DEV_OBO_FALLBACK_KEY) === true;
}

/**
 * Narrow an unknown thrown value to an Error that carries a numeric
 * `statusCode` property (e.g. `ApiError` from `@databricks/sdk-experimental`).
 */
function hasHttpStatusCode(
  error: unknown,
): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as Record<string, unknown>).statusCode === "number"
  );
}

/**
 * Methods that should not be proxied by asUser().
 * These are lifecycle/internal methods that don't make sense
 * to execute in a user context.
 */
const EXCLUDED_FROM_PROXY = new Set([
  // Lifecycle methods
  "setup",
  "shutdown",
  "attachContext",
  "injectRoutes",
  "getEndpoints",
  "getSkipBodyParsingPaths",
  "abortActiveOperations",
  "clientConfig",
  // asUser itself - prevent chaining like .asUser().asUser()
  "asUser",
  // Internal methods
  "constructor",
]);

/**
 * Base abstract class for creating AppKit plugins.
 *
 * All plugins must declare a static `manifest` property with their metadata
 * and resource requirements. The manifest defines:
 * - `required` resources: Always needed for the plugin to function
 * - `optional` resources: May be needed depending on plugin configuration
 *
 * ## Static vs Runtime Resource Requirements
 *
 * The manifest is static and doesn't know the plugin's runtime configuration.
 * For resources that become required based on config options, plugins can
 * implement a static `getResourceRequirements(config)` method.
 *
 * At runtime, this method is called with the actual config to determine
 * which "optional" resources should be treated as "required".
 *
 * @example Basic plugin with static requirements
 * ```typescript
 * import { Plugin, toPlugin, PluginManifest, ResourceType } from '@databricks/appkit';
 *
 * const myManifest: PluginManifest = {
 *   name: 'myPlugin',
 *   displayName: 'My Plugin',
 *   description: 'Does something awesome',
 *   resources: {
 *     required: [
 *       { type: ResourceType.SQL_WAREHOUSE, alias: 'warehouse', ... }
 *     ],
 *     optional: []
 *   }
 * };
 *
 * class MyPlugin extends Plugin<MyConfig> {
 *   static manifest = myManifest;
 * }
 * ```
 *
 * @example Plugin with config-dependent resources
 * ```typescript
 * interface MyConfig extends BasePluginConfig {
 *   enableCaching?: boolean;
 * }
 *
 * const myManifest: PluginManifest = {
 *   name: 'myPlugin',
 *   resources: {
 *     required: [
 *       { type: ResourceType.SQL_WAREHOUSE, alias: 'warehouse', ... }
 *     ],
 *     optional: [
 *       // Database is optional in the static manifest
 *       { type: ResourceType.DATABASE, alias: 'cache', description: 'Required if caching enabled', ... }
 *     ]
 *   }
 * };
 *
 * class MyPlugin extends Plugin<MyConfig> {
 *   static manifest = myManifest<"myPlugin">;
 *
 *   // Runtime method: converts optional resources to required based on config
 *   static getResourceRequirements(config: MyConfig) {
 *     const resources = [];
 *     if (config.enableCaching) {
 *       // When caching is enabled, Database becomes required
 *       resources.push({
 *         type: ResourceType.DATABASE,
 *         alias: 'cache',
 *         resourceKey: 'database',
 *         description: 'Cache storage for query results',
 *         permission: 'CAN_CONNECT_AND_CREATE',
 *         fields: {
 *           instance_name: { env: 'DATABRICKS_CACHE_INSTANCE' },
 *           database_name: { env: 'DATABRICKS_CACHE_DB' },
 *         },
 *         required: true  // Mark as required at runtime
 *       });
 *     }
 *     return resources;
 *   }
 * }
 * ```
 */
export abstract class Plugin<
  TConfig extends BasePluginConfig = BasePluginConfig,
> implements BasePlugin
{
  protected isReady = false;
  protected cache!: CacheManager;
  protected app: AppManager;
  protected devFileReader: DevFileReader;
  protected streamManager: StreamManager;
  protected telemetry!: ITelemetry;
  protected context?: PluginContext;

  /** Registered endpoints for this plugin */
  private registeredEndpoints: PluginEndpointMap = {};

  /** Paths that opt out of JSON body parsing (e.g. file upload routes) */
  private skipBodyParsingPaths: Set<string> = new Set();

  /**
   * Plugin initialization phase.
   * - 'core': Initialized first (e.g., config plugins)
   * - 'normal': Initialized second (most plugins)
   * - 'deferred': Initialized last (e.g., server plugin)
   */
  static phase: PluginPhase = "normal";

  /**
   * Plugin name identifier.
   */
  name: string;

  constructor(protected config: TConfig) {
    this.name =
      config.name ??
      (this.constructor as { manifest?: { name: string } }).manifest?.name ??
      "plugin";
    this.streamManager = new StreamManager();
    this.app = new AppManager();
    this.devFileReader = DevFileReader.getInstance();
    this.context = (config as Record<string, unknown>).context as
      | PluginContext
      | undefined;

    // Eagerly bind telemetry + cache if the core services have already been
    // initialized (normal createApp path, or tests that mock CacheManager).
    // If they haven't, we leave these undefined and rely on `attachContext`
    // being called later — this lets factories eagerly construct plugin
    // instances at module top-level before `createApp` has run.
    this.tryAttachContext();
  }

  private tryAttachContext(): void {
    try {
      this.cache = CacheManager.getInstanceSync();
    } catch {
      return;
    }
    this.telemetry = TelemetryManager.getProvider(
      this.name,
      this.config.telemetry,
    );
    this.isReady = true;
  }

  /**
   * Binds runtime dependencies (telemetry provider, cache, plugin context) to
   * this plugin. Called by `AppKit._createApp` after construction and before
   * `setup()`. Idempotent: safe to call if the constructor already bound them
   * eagerly. Kept separate so factories can eagerly construct plugin instances
   * without running this before `TelemetryManager.initialize()` /
   * `CacheManager.getInstance()` have run.
   */
  attachContext(
    deps: {
      context?: unknown;
      telemetryConfig?: BasePluginConfig["telemetry"];
    } = {},
  ): void {
    if (!this.cache) {
      this.cache = CacheManager.getInstanceSync();
    }
    this.telemetry = TelemetryManager.getProvider(
      this.name,
      deps.telemetryConfig ?? this.config.telemetry,
    );
    if (deps.context !== undefined) {
      this.context = deps.context as PluginContext;
    }
    this.isReady = true;
  }

  injectRoutes(_: express.Router) {
    return;
  }

  async setup() {}

  getEndpoints(): PluginEndpointMap {
    return this.registeredEndpoints;
  }

  getSkipBodyParsingPaths(): ReadonlySet<string> {
    return this.skipBodyParsingPaths;
  }

  abortActiveOperations(): void {
    this.streamManager.abortAll();
  }

  /**
   * Returns the public exports for this plugin.
   * Override this to define a custom public API.
   * By default, returns an empty object.
   *
   * The returned object becomes the plugin's public API on the AppKit instance
   * (e.g. `appkit.myPlugin.method()`). AppKit automatically binds method context
   * and adds `asUser(req)` for user-scoped execution.
   *
   * @example
   * ```ts
   * class MyPlugin extends Plugin {
   *   private getData() { return []; }
   *
   *   exports() {
   *     return { getData: this.getData };
   *   }
   * }
   *
   * // After registration:
   * const appkit = await createApp({ plugins: [myPlugin()] });
   * appkit.myPlugin.getData();
   * ```
   */
  exports(): unknown {
    return {};
  }

  /**
   * Returns startup config to expose to the client.
   * Override this to surface server-side values that are safe to publish to the
   * frontend, such as feature flags, resource IDs, or other app boot settings.
   *
   * This runs once when the server starts, so it should not depend on
   * request-scoped or user-specific state.
   *
   * String values that match non-public environment variables are redacted
   * unless you intentionally expose them via a matching `PUBLIC_APPKIT_` env var.
   *
   * Values must be JSON-serializable plain data (no functions, Dates, classes,
   * Maps, Sets, BigInts, or circular references).
   * By default returns an empty object (plugin contributes nothing to client config).
   *
   * On the client, read the config with the `usePluginClientConfig` hook
   * (React) or the `getPluginClientConfig` function (vanilla JS), both
   * from `@databricks/appkit-ui`.
   *
   * @example
   * ```ts
   * // Server — plugin definition
   * class MyPlugin extends Plugin<MyConfig> {
   *   clientConfig() {
   *     return {
   *       warehouseId: this.config.warehouseId,
   *       features: { darkMode: true },
   *     };
   *   }
   * }
   *
   * // Client — React component
   * import { usePluginClientConfig } from "@databricks/appkit-ui/react";
   *
   * interface MyPluginConfig { warehouseId: string; features: { darkMode: boolean } }
   *
   * const config = usePluginClientConfig<MyPluginConfig>("myPlugin");
   * config.warehouseId; // "abc-123"
   *
   * // Client — vanilla JS
   * import { getPluginClientConfig } from "@databricks/appkit-ui/js";
   *
   * const config = getPluginClientConfig<MyPluginConfig>("myPlugin");
   * ```
   */
  clientConfig(): Record<string, unknown> {
    return {};
  }

  /**
   * Resolve the effective user ID from a request.
   *
   * Returns the `x-forwarded-user` header when present. In development mode
   * (`NODE_ENV=development`) falls back to the current context user ID so
   * that callers outside an active `runInUserContext` scope still get a
   * consistent value.
   *
   * @throws AuthenticationError in production when no user header is present.
   */
  protected resolveUserId(req: express.Request): string {
    const userId = req.header("x-forwarded-user")?.trim();
    if (userId) return userId;
    if (process.env.NODE_ENV === "development") return getCurrentUserId();
    throw AuthenticationError.missingUserId();
  }

  /**
   * Execute operations using the user's identity from the request.
   * Returns a proxy of this plugin where all method calls execute
   * with the user's Databricks credentials instead of the service principal.
   *
   * @param req - The Express request containing the user token in headers
   * @returns A proxied plugin instance that executes as the user
   * @throws AuthenticationError if user token is not available in request headers (production only).
   *   In development mode (`NODE_ENV=development`), skips user impersonation instead of throwing.
   */
  asUser(req: express.Request): this {
    const token = req.header("x-forwarded-access-token")?.trim();
    const userId = req.header("x-forwarded-user")?.trim();
    const userEmail = req.header("x-forwarded-email");
    const isDev = process.env.NODE_ENV === "development";

    // In local development, skip user impersonation since there's no user
    // token available. Mark execution as OBO dev fallback via OTel context
    // so telemetry can distinguish intended OBO calls from regular SP calls.
    if (!token && isDev) {
      logger.warn(
        "asUser() called without user token in development mode. Skipping user impersonation.",
      );

      return this._createAsUserProxy((fn) => (...args) => {
        const ctx = otelContext.active().setValue(DEV_OBO_FALLBACK_KEY, true);
        return otelContext.with(ctx, () => fn(...args));
      });
    }

    if (!token) {
      throw AuthenticationError.missingToken("user token");
    }

    if (!userId && !isDev) {
      throw AuthenticationError.missingUserId();
    }

    const effectiveUserId = userId || "dev-user";

    const userContext = ServiceContext.createUserContext(
      token,
      effectiveUserId,
      undefined,
      userEmail ?? undefined,
    );

    return this._createAsUserProxy(
      (fn) =>
        (...args) =>
          runInUserContext(userContext, () => fn(...args)),
    );
  }

  /**
   * Creates a proxy of `this` where every method call — and every function
   * in the result of `exports()` — runs inside `wrapCall`.
   *
   * `wrapCall` decides the per-call scope. Two strategies are used today:
   *   - real OBO:     fn => (...args) => runInUserContext(userContext, () => fn(...args))
   *   - dev fallback: fn => (...args) => otelContext.with(DEV_OBO_FALLBACK_KEY=true, () => fn(...args))
   *
   * `exports` is intercepted because methods captured in the returned
   * exports object never re-enter the proxy's `get` trap. Wrapping them
   * here is the only way to make the user context follow function
   * references back out of the plugin.
   */
  private _createAsUserProxy(
    wrapCall: (
      fn: (...a: unknown[]) => unknown,
    ) => (...a: unknown[]) => unknown,
  ): this {
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);

        if (typeof value !== "function") return value;
        if (typeof prop === "string" && EXCLUDED_FROM_PROXY.has(prop))
          return value;

        if (prop === "exports") {
          return () => {
            const raw = (value as () => unknown).call(target);
            if (raw == null) return {};
            // Callable exports (e.g. files, jobs) manage per-call asUser
            // themselves; leave them untouched.
            if (typeof raw === "function") return raw;
            if (isPlainObject(raw)) {
              return wrapExportFunctions(raw, wrapCall);
            }
            return raw;
          };
        }

        const fn = (value as (...a: unknown[]) => unknown).bind(target);
        return wrapCall(fn);
      },
    }) as this;
  }

  // streaming execution with interceptors
  protected async executeStream<T>(
    res: IAppResponse,
    fn: StreamExecuteHandler<T>,
    options: StreamExecutionSettings,
    userKey?: string,
  ) {
    // destructure options
    const {
      stream: streamConfig,
      default: defaultConfig,
      user: userConfig,
    } = options;

    // build execution options
    const executeConfig = this._buildExecutionConfig({
      default: defaultConfig,
      user: userConfig,
    });

    // get user key from context if not provided
    const effectiveUserKey = userKey ?? getCurrentUserId();

    const self = this;
    // capture the active OTel context (HTTP span) before entering the async generator,
    // where it would otherwise be lost across the async boundary
    const parentOtelContext = otelContext.active();

    // wrapper function to ensure it returns a generator
    const asyncWrapperFn = async function* (streamSignal?: AbortSignal) {
      // build execution context
      const context: InterceptorContext = {
        signal: streamSignal,
        metadata: new Map(),
        userKey: effectiveUserKey,
      };

      // build interceptors
      const interceptors = self._buildInterceptors(executeConfig);

      // wrap the function to ensure it returns a promise
      const wrappedFn = async () => {
        const result = await fn(context.signal);
        return result;
      };

      // execute the function with interceptors, restoring the parent OTel context
      // so telemetry spans are linked as children of the HTTP request span
      const result = await otelContext.with(parentOtelContext, () =>
        self._executeWithInterceptors(
          wrappedFn as (signal?: AbortSignal) => Promise<T>,
          interceptors,
          context,
        ),
      );

      // check if result is a generator
      if (self._checkIfGenerator(result)) {
        yield* result;
      } else {
        yield result;
      }
    };

    // stream the result to the client. The effective user key is forwarded
    // to the stream manager so that reconnections to existing streamIds are
    // bound to the original creator (prevents cross-user stream takeover via
    // guessed/leaked IDs).
    await this.streamManager.stream(
      res,
      asyncWrapperFn,
      streamConfig,
      effectiveUserKey,
    );
  }

  /**
   * Execute a function with the plugin's interceptor chain.
   *
   * Returns an {@link ExecutionResult} discriminated union:
   * - `{ ok: true, data: T }` on success
   * - `{ ok: false, status: number, message: string }` on failure
   *
   * Errors are never thrown — the method is production-safe.
   */
  protected async execute<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    options: PluginExecutionSettings,
    userKey?: string,
  ): Promise<ExecutionResult<T>> {
    const executeConfig = this._buildExecutionConfig(options);

    const interceptors = this._buildInterceptors(executeConfig);

    // get user key from context if not provided
    const effectiveUserKey = userKey ?? getCurrentUserId();

    const context: InterceptorContext = {
      metadata: new Map(),
      userKey: effectiveUserKey,
    };

    try {
      const data = await this._executeWithInterceptors(
        fn,
        interceptors,
        context,
      );
      return { ok: true, data };
    } catch (error) {
      logger.error("Plugin execution failed", { error, plugin: this.name });

      if (error instanceof AppKitError) {
        return {
          ok: false,
          status: error.statusCode,
          message: error.message,
        };
      }

      if (hasHttpStatusCode(error)) {
        const isDev = process.env.NODE_ENV !== "production";
        const isClientError = error.statusCode >= 400 && error.statusCode < 500;
        return {
          ok: false,
          status: error.statusCode,
          message: isDev || isClientError ? error.message : "Server error",
        };
      }

      const isDev = process.env.NODE_ENV !== "production";
      return {
        ok: false,
        status: 500,
        message:
          isDev && error instanceof Error ? error.message : "Server error",
      };
    }
  }

  protected registerEndpoint(name: string, path: string): void {
    this.registeredEndpoints[name] = path;
  }

  protected route<_TResponse>(
    router: express.Router,
    config: RouteConfig,
  ): void {
    const { name, method, path, handler } = config;

    router[method](path, handler);

    const fullPath = `/api/${this.name}${path}`;
    this.registerEndpoint(name, fullPath);

    if (config.skipBodyParsing) {
      this.skipBodyParsingPaths.add(fullPath);
    }
  }

  // build execution options by merging defaults, plugin config, and user overrides
  private _buildExecutionConfig(
    options: PluginExecutionSettings,
  ): PluginExecuteConfig {
    const { default: methodDefaults, user: userOverride } = options;

    // Merge: method defaults <- plugin config <- user override (highest priority)
    return deepMerge(
      deepMerge(methodDefaults, this.config),
      userOverride ?? {},
    ) as PluginExecuteConfig;
  }

  // build interceptors based on execute options
  private _buildInterceptors(
    options: PluginExecuteConfig,
  ): ExecutionInterceptor[] {
    const interceptors: ExecutionInterceptor[] = [];

    // order matters: telemetry → timeout → retry → cache (innermost to outermost)

    const telemetryConfig = normalizeTelemetryOptions(this.config.telemetry);
    if (
      telemetryConfig.traces &&
      (options.telemetryInterceptor?.enabled ?? true)
    ) {
      interceptors.push(
        new TelemetryInterceptor(this.telemetry, options.telemetryInterceptor),
      );
    }

    if (options.timeout && options.timeout > 0) {
      interceptors.push(new TimeoutInterceptor(options.timeout));
    }

    if (
      options.retry?.enabled &&
      options.retry.attempts &&
      options.retry.attempts > 1
    ) {
      interceptors.push(new RetryInterceptor(options.retry));
    }

    if (options.cache?.enabled && options.cache.cacheKey?.length) {
      interceptors.push(new CacheInterceptor(this.cache, options.cache));
    }

    return interceptors;
  }

  // execute method wrapped with interceptors
  private async _executeWithInterceptors<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    interceptors: ExecutionInterceptor[],
    context: InterceptorContext,
  ): Promise<T> {
    // no interceptors, execute directly
    if (interceptors.length === 0) {
      return fn(context.signal);
    }
    // build nested execution chain from interceptors
    let wrappedFn = () => fn(context.signal);

    // wrap each interceptor around the previous function
    for (const interceptor of interceptors) {
      const previousFn = wrappedFn;
      wrappedFn = () => interceptor.intercept(previousFn, context);
    }

    return wrappedFn();
  }

  private _checkIfGenerator(
    result: any,
  ): result is AsyncGenerator<any, void, unknown> {
    return (
      result && typeof result === "object" && Symbol.asyncIterator in result
    );
  }
}
