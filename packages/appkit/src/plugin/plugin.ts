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
import {
  getCurrentUserId,
  runInUserContext,
  ServiceContext,
  type UserContext,
} from "../context";
import { AuthenticationError } from "../errors";
import { createLogger } from "../logging/logger";
import { StreamManager } from "../stream";
import {
  type ITelemetry,
  normalizeTelemetryOptions,
  TelemetryManager,
} from "../telemetry";
import { deepMerge, validateEnv } from "../utils";
import { DevFileReader } from "./dev-reader";
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
 * Methods that should not be proxied by asUser().
 * These are lifecycle/internal methods that don't make sense
 * to execute in a user context.
 */
const EXCLUDED_FROM_PROXY = new Set([
  // Lifecycle methods
  "setup",
  "shutdown",
  "validateEnv",
  "injectRoutes",
  "getEndpoints",
  "abortActiveOperations",
  // asUser itself - prevent chaining like .asUser().asUser()
  "asUser",
  // Internal methods
  "constructor",
]);

/** Base abstract class for creating AppKit plugins */
export abstract class Plugin<
  TConfig extends BasePluginConfig = BasePluginConfig,
> implements BasePlugin
{
  protected isReady = false;
  protected cache: CacheManager;
  protected app: AppManager;
  protected devFileReader: DevFileReader;
  protected streamManager: StreamManager;
  protected telemetry: ITelemetry;
  protected abstract envVars: string[];

  /** Registered endpoints for this plugin */
  private registeredEndpoints: PluginEndpointMap = {};

  static phase: PluginPhase = "normal";
  name: string;

  constructor(protected config: TConfig) {
    this.name = config.name ?? "plugin";
    this.telemetry = TelemetryManager.getProvider(this.name, config.telemetry);
    this.streamManager = new StreamManager();
    this.cache = CacheManager.getInstanceSync();
    this.app = new AppManager();
    this.devFileReader = DevFileReader.getInstance();

    this.isReady = true;
  }

  validateEnv() {
    validateEnv(this.envVars);
  }

  injectRoutes(_: express.Router) {
    return;
  }

  async setup() {}

  getEndpoints(): PluginEndpointMap {
    return this.registeredEndpoints;
  }

  abortActiveOperations(): void {
    this.streamManager.abortAll();
  }

  /**
   * Execute operations using the user's identity from the request.
   *
   * Returns a scoped instance of this plugin where all method calls
   * will execute with the user's Databricks credentials instead of
   * the service principal.
   *
   * @param req - The Express request containing the user token in headers
   * @returns A scoped plugin instance that executes as the user
   * @throws Error if user token is not available in request headers
   *
   * @example
   * ```typescript
   * // In route handler - execute query as the requesting user
   * router.post('/users/me/query/:key', async (req, res) => {
   *   const result = await this.asUser(req).query(req.params.key)
   *   res.json(result)
   * })
   *
   * // Mixed execution in same handler
   * router.post('/dashboard', async (req, res) => {
   *   const [systemData, userData] = await Promise.all([
   *     this.getSystemStats(),                  // Service principal
   *     this.asUser(req).getUserPreferences(), // User context
   *   ])
   *   res.json({ systemData, userData })
   * })
   * ```
   */
  asUser(req: express.Request): this {
    const token = req.headers["x-forwarded-access-token"] as string;
    const userId = req.headers["x-forwarded-user"] as string;
    const isDev = process.env.NODE_ENV === "development";

    // In local development, fall back to service principal
    // since there's no user token available
    if (!token && isDev) {
      logger.warn(
        "asUser() called without user token in development mode. Using service principal.",
      );

      return this;
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
    );

    // Return a proxy that wraps method calls in user context
    return this.createUserContextProxy(userContext);
  }

  /**
   * Creates a proxy that wraps method calls in a user context.
   * This allows all plugin methods to automatically use the user's
   * Databricks credentials.
   */
  private createUserContextProxy(userContext: UserContext): this {
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);

        if (typeof value !== "function") {
          return value;
        }

        if (typeof prop === "string" && EXCLUDED_FROM_PROXY.has(prop)) {
          return value;
        }

        return (...args: unknown[]) => {
          return runInUserContext(userContext, () => value.apply(target, args));
        };
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

      // execute the function with interceptors
      const result = await self._executeWithInterceptors(
        wrappedFn as (signal?: AbortSignal) => Promise<T>,
        interceptors,
        context,
      );

      // check if result is a generator
      if (self._checkIfGenerator(result)) {
        yield* result;
      } else {
        yield result;
      }
    };

    // stream the result to the client
    await this.streamManager.stream(res, asyncWrapperFn, streamConfig);
  }

  // single sync execution with interceptors
  protected async execute<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    options: PluginExecutionSettings,
    userKey?: string,
  ): Promise<T | undefined> {
    const executeConfig = this._buildExecutionConfig(options);

    const interceptors = this._buildInterceptors(executeConfig);

    // get user key from context if not provided
    const effectiveUserKey = userKey ?? getCurrentUserId();

    const context: InterceptorContext = {
      metadata: new Map(),
      userKey: effectiveUserKey,
    };

    try {
      return await this._executeWithInterceptors(fn, interceptors, context);
    } catch (_error) {
      // production-safe, don't crash sdk
      return undefined;
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

    this.registerEndpoint(name, `/api/${this.name}${path}`);
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
