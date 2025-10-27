import { AsyncLocalStorage } from "node:async_hooks";
import { AppManager } from "@databricks-apps/app";
import { CacheManager } from "@databricks-apps/cache";
import { StreamManager } from "@databricks-apps/stream";
import type {
  BasePlugin,
  BasePluginConfig,
  PluginExecuteConfig,
  PluginExecutionSettings,
  IAppResponse,
  IAuthManager,
  PluginPhase,
  StreamExecuteHandler,
  StreamExecutionSettings,
  WithInjectedToken,
} from "@databricks-apps/types";
import { deepMerge, validateEnv } from "@databricks-apps/utils";
import type express from "express";
import { CacheInterceptor } from "./interceptors/cache";
import { RetryInterceptor } from "./interceptors/retry";
import { TimeoutInterceptor } from "./interceptors/timeout";
import type {
  ExecutionContext,
  ExecutionInterceptor,
} from "./interceptors/types";

const tokenContext = new AsyncLocalStorage<{ token: string }>();

export abstract class Plugin<
  TConfig extends BasePluginConfig = BasePluginConfig,
> implements BasePlugin
{
  protected isReady = false;
  protected auth: IAuthManager;
  protected cache: CacheManager;
  protected app: AppManager;
  protected streamManager: StreamManager;
  protected abstract envVars: string[];

  static phase: PluginPhase = "normal";
  name: string;

  constructor(
    protected config: TConfig,
    auth: IAuthManager,
  ) {
    this.name = config.name ?? "plugin";
    this.auth = auth;
    this.streamManager = new StreamManager();
    this.cache = new CacheManager();
    this.app = new AppManager();

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

  asUser(userToken: string): WithInjectedToken<typeof this> {
    if (!userToken) throw new Error("User token is required");

    const runner = this;
    const handler: ProxyHandler<typeof this> = {
      get(target, prop, receiver) {
        const orig = Reflect.get(target, prop, receiver);

        if (typeof orig === "function") {
          return (...args: any[]) => {
            return tokenContext.run({ token: userToken }, () =>
              orig.apply(runner, args),
            );
          };
        }

        return orig;
      },
    };

    return new Proxy(runner, handler) as WithInjectedToken<typeof this>;
  }

  protected get userToken(): string | undefined {
    return tokenContext.getStore()?.token;
  }

  // streaming execution with interceptors
  protected async executeStream<T>(
    res: IAppResponse,
    fn: StreamExecuteHandler<T>,
    options: StreamExecutionSettings,
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
    const capturedUserToken = this.userToken;

    // wrapper function to ensure it returns a generator
    const asyncWrapperFn = async function* (streamSignal?: AbortSignal) {
      // build execution context
      const context: ExecutionContext = {
        signal: streamSignal,
        metadata: new Map(),
        userToken: capturedUserToken,
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
  ): Promise<T | undefined> {
    const executeConfig = this._buildExecutionConfig(options);

    const interceptors = this._buildInterceptors(executeConfig);

    const context: ExecutionContext = {
      metadata: new Map(),
      userToken: this.userToken,
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

    // order matters: timeout → retry → cache (innermost to outermost)
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
