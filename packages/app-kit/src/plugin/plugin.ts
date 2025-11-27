import {
  type ITelemetry,
  normalizeTelemetryOptions,
  TelemetryManager,
} from "../telemetry";
import { AppManager } from "../app";
import { CacheManager } from "../cache";
import { StreamManager } from "../stream";
import type {
  BasePlugin,
  BasePluginConfig,
  IAppResponse,
  PluginExecuteConfig,
  PluginExecutionSettings,
  PluginPhase,
  StreamExecuteHandler,
  StreamExecutionSettings,
} from "shared";
import { deepMerge, validateEnv } from "../utils";
import type express from "express";
import { DevFileReader } from "./dev-reader";
import { CacheInterceptor } from "./interceptors/cache";
import { RetryInterceptor } from "./interceptors/retry";
import { TelemetryInterceptor } from "./interceptors/telemetry";
import { TimeoutInterceptor } from "./interceptors/timeout";
import type {
  ExecutionContext,
  ExecutionInterceptor,
} from "./interceptors/types";

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

  static phase: PluginPhase = "normal";
  name: string;

  constructor(protected config: TConfig) {
    this.name = config.name ?? "plugin";
    this.telemetry = TelemetryManager.getProvider(this.name, config.telemetry);
    this.streamManager = new StreamManager();
    this.cache = new CacheManager(undefined, this.telemetry);
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

  abortActiveOperations(): void {
    this.streamManager.abortAll();
  }

  // streaming execution with interceptors
  protected async executeStream<T>(
    res: IAppResponse,
    fn: StreamExecuteHandler<T>,
    options: StreamExecutionSettings,
    userKey: string,
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

    const self = this;

    // wrapper function to ensure it returns a generator
    const asyncWrapperFn = async function* (streamSignal?: AbortSignal) {
      // build execution context
      const context: ExecutionContext = {
        signal: streamSignal,
        metadata: new Map(),
        userKey: userKey,
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
    userKey: string,
  ): Promise<T | undefined> {
    const executeConfig = this._buildExecutionConfig(options);

    const interceptors = this._buildInterceptors(executeConfig);

    const context: ExecutionContext = {
      metadata: new Map(),
      userKey: userKey,
    };

    try {
      return await this._executeWithInterceptors(fn, interceptors, context);
    } catch (_error) {
      // production-safe, don't crash sdk
      return undefined;
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

    // Only add telemetry interceptor if traces are enabled
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
    context: ExecutionContext,
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
