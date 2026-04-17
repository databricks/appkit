import { randomUUID } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type express from "express";
import type {
  BasePlugin,
  BasePluginConfig,
  IAppRequestWithBody,
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
 * Character allowlist for incoming `x-request-id` headers. Restricts to
 * URL-safe ASCII + underscore/hyphen and caps length at 100 characters so
 * client-supplied values can never contain CRLF (log-injection / CWE-117)
 * or blow up server memory.
 */
const REQUEST_ID_HEADER_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Resolve a request ID from the `x-request-id` header (if present), falling
 * back to a freshly generated UUID-derived token. Used by the body
 * validation wrapper so operators can correlate a client-facing 400 with
 * the full server-side issue log.
 *
 * The header value is validated against a strict allowlist. Invalid values
 * are silently discarded — they are never logged or reflected anywhere —
 * and a fresh ID is generated instead.
 */
function resolveRequestId(req: express.Request): string {
  const headerId = req.header("x-request-id");
  if (
    typeof headerId === "string" &&
    REQUEST_ID_HEADER_PATTERN.test(headerId)
  ) {
    return headerId;
  }
  return `req_${randomUUID().slice(0, 8)}`;
}

/** Maximum number of Standard Schema issues retained on a validation failure. */
const MAX_VALIDATION_ISSUES = 20;

/**
 * Shallow runtime check that a value looks like a Standard Schema v1
 * compliant validator (object with a `~standard` property exposing a
 * `validate` function). Used to surface plugin programmer errors at route
 * registration time.
 */
function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (typeof value !== "object" || value === null) return false;
  const standard = (value as { "~standard"?: unknown })["~standard"];
  if (typeof standard !== "object" || standard === null) return false;
  return typeof (standard as { validate?: unknown }).validate === "function";
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
  protected cache: CacheManager;
  protected app: AppManager;
  protected devFileReader: DevFileReader;
  protected streamManager: StreamManager;
  protected telemetry: ITelemetry;

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
    this.telemetry = TelemetryManager.getProvider(this.name, config.telemetry);
    this.streamManager = new StreamManager();
    this.cache = CacheManager.getInstanceSync();
    this.app = new AppManager();
    this.devFileReader = DevFileReader.getInstance();

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
    const userId = req.header("x-forwarded-user");
    if (userId) return userId;
    if (process.env.NODE_ENV === "development") return getCurrentUserId();
    throw AuthenticationError.missingToken(
      "Missing x-forwarded-user header. Cannot resolve user ID.",
    );
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
    const token = req.header("x-forwarded-access-token");
    const userId = req.header("x-forwarded-user");
    const isDev = process.env.NODE_ENV === "development";

    // In local development, skip user impersonation
    // since there's no user token available
    if (!token && isDev) {
      logger.warn(
        "asUser() called without user token in development mode. Skipping user impersonation.",
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
    return this._createUserContextProxy(userContext);
  }

  /**
   * Creates a proxy that wraps method calls in a user context.
   * This allows all plugin methods to automatically use the user's
   * Databricks credentials.
   */
  private _createUserContextProxy(userContext: UserContext): this {
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

  /**
   * Bind a handler to a router path with optional `req.body` validation.
   *
   * Overloads exist because `RouteConfig<TBody>` carries two independent
   * uses of `TBody` — `body: StandardSchemaV1<unknown, TBody>` and
   * `handler: (req: IAppRequestWithBody<TBody>, …)`. Without overloads,
   * plugin authors can pass a schema whose output diverges from the
   * declared handler body type; the compiler stays quiet and runtime
   * narrowing silently disagrees. The overloads below tie `TBody` to the
   * schema's `InferOutput` when `body` is present, so the handler always
   * sees the schema's real output type. When `body` is absent, `TBody`
   * resolves to `unknown` so handlers must narrow before use.
   *
   * Note: `RouteConfig<TBody = any>` default is load-bearing for backward
   * compat with handlers typed as plain `express.Request`. DO NOT "fix"
   * it to `unknown` — cascades into mass typecheck breakage.
   *
   * If you're confused why this needs overloads: TypeScript cannot otherwise
   * enforce that `TBody` equals `StandardSchemaV1.InferOutput<typeof body>`
   * when both are separate type parameters on the same function.
   */
  protected route<TSchema extends StandardSchemaV1<unknown, any>>(
    router: express.Router,
    config: RouteConfig<StandardSchemaV1.InferOutput<TSchema>> & {
      body: TSchema;
    },
  ): void;
  protected route(
    router: express.Router,
    config: Omit<RouteConfig<unknown>, "body"> & { body?: undefined },
  ): void;
  protected route(
    router: express.Router,
    config:
      | (RouteConfig<any> & { body: StandardSchemaV1<unknown, any> })
      | (Omit<RouteConfig<unknown>, "body"> & { body?: undefined }),
  ): void {
    const { name, method, path, handler } = config;

    // Fail-fast: catch mis-wired `body` values at registration time so plugin
    // programmer errors surface at startup instead of the first request.
    if (config.body !== undefined && !isStandardSchema(config.body)) {
      throw new Error(
        "RouteConfig.body must be a Standard Schema v1 compliant value (e.g., a Zod schema)",
      );
    }

    // Zero-overhead pass-through when no body schema is provided.
    const effectiveHandler = config.body
      ? this._wrapHandlerWithBodyValidation(
          handler,
          config.body,
          config.exposeValidationErrors === true,
        )
      : (handler as (
          req: express.Request,
          res: express.Response,
        ) => Promise<void>);

    router[method](path, effectiveHandler);

    const fullPath = `/api/${this.name}${path}`;
    this.registerEndpoint(name, fullPath);

    if (config.skipBodyParsing) {
      this.skipBodyParsingPaths.add(fullPath);
    }
  }

  /**
   * Wrap a route handler in a pre-validation closure. When the wrapped
   * handler runs, the request body is validated against the provided
   * Standard Schema before the original handler is invoked.
   *
   * On validation failure the wrapper emits a canonical 400 response and
   * does not call the original handler. On success the request body is
   * reassigned to the validated value (preserving any narrowing/coercion)
   * and the original handler runs as before.
   *
   * Exceptions thrown from the validator itself (sync throw from a
   * user-written `.refine()`, or a rejected Promise from an async
   * validate) are caught and converted into a canonical 500 response. The
   * thrown error's message is never leaked to the client — only a fixed
   * code is returned.
   */
  private _wrapHandlerWithBodyValidation<TBody>(
    handler: RouteConfig<TBody>["handler"],
    schema: StandardSchemaV1<unknown, TBody>,
    exposeValidationErrors: boolean,
  ): (req: express.Request, res: express.Response) => Promise<void> {
    return async (req, res) => {
      let result: StandardSchemaV1.Result<TBody>;
      try {
        const maybePromise = schema["~standard"].validate(req.body);
        result =
          maybePromise instanceof Promise ? await maybePromise : maybePromise;
      } catch (error) {
        const requestId = resolveRequestId(req);
        // Log via AppKitError-compatible path so sensitive values inside
        // `context` are redacted. The thrown error's free-form message is
        // intentionally omitted to avoid leaking refinement internals.
        logger.error("validation schema threw unexpectedly", {
          plugin: this.name,
          requestId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        res.status(500).json({
          error: "Internal validation error",
          code: "VALIDATION_INTERNAL_ERROR",
          requestId,
        });
        return;
      }

      if (result.issues) {
        const requestId = resolveRequestId(req);
        const totalIssueCount = result.issues.length;
        const truncated = totalIssueCount > MAX_VALIDATION_ISSUES;
        const retained = truncated
          ? result.issues.slice(0, MAX_VALIDATION_ISSUES)
          : result.issues;

        // Normalize Standard Schema path segments: spec allows either a
        // PropertyKey or an object with a `key` field. Callers expect a
        // plain ReadonlyArray<PropertyKey>.
        const normalizedIssues = retained.map((issue) => ({
          path: Array.isArray(issue.path)
            ? (issue.path.map((segment) =>
                typeof segment === "object" && segment !== null
                  ? segment.key
                  : segment,
              ) as ReadonlyArray<PropertyKey>)
            : ([] as ReadonlyArray<PropertyKey>),
          message: issue.message,
        }));

        // Log only path metadata server-side; `issue.message` can contain
        // arbitrary refinement text and would not pass through the
        // AppKitError redactor. Callers can opt in to full issue content
        // via `exposeValidationErrors` in the response.
        logger.warn("Request body validation failed", {
          plugin: this.name,
          requestId,
          issueCount: totalIssueCount,
          truncated,
          paths: normalizedIssues.map((issue) => issue.path),
        });

        const isProduction = process.env.NODE_ENV === "production";
        const includeIssues = !isProduction || exposeValidationErrors;

        const body: {
          error: string;
          code: string;
          requestId: string;
          issues?: Array<{
            path: ReadonlyArray<PropertyKey>;
            message: string;
          }>;
          issuesTruncated?: boolean;
        } = {
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
          requestId,
        };
        if (includeIssues) {
          body.issues = normalizedIssues;
          if (truncated) {
            body.issuesTruncated = true;
          }
        }

        res.status(400).json(body);
        return;
      }

      // Narrow req.body to the validated value. This preserves any
      // transformation performed by the schema (e.g. coercion), though
      // v1 docs advise against relying on transforms.
      (req as { body: unknown }).body = result.value;

      await handler(req as IAppRequestWithBody<TBody>, res);
    };
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
