import type express from "express";
import { CacheManager } from "@databricks-apps/cache";
import type {
  BasePlugin,
  WithInjectedToken,
  PluginPhase,
  IAuthManager,
} from "@databricks-apps/types";
import type { CacheConfig } from "@databricks-apps/types";
import type { ExecuteOptions } from "@databricks-apps/types";
import { validateEnv, deepMerge } from "@databricks-apps/utils";

export abstract class Plugin implements BasePlugin {
  protected isReady = false;
  protected auth: IAuthManager;
  protected cache: CacheManager;
  protected abstract envVars: string[];
  private _userToken?: string;

  static phase: PluginPhase = "normal";
  name: string;

  abortActiveOperations?(): void;

  constructor(protected config: any, auth: IAuthManager) {
    this.name = config.name;
    
    this.auth = auth;
    this.cache = new CacheManager();

    this.isReady = true;
  }

  validateEnv() {
    validateEnv(this.envVars);
  }

  injectRoutes(router: express.Router) {
    return;
  }

  async setup() {}
  
  asUser(userToken: string): WithInjectedToken<typeof this> {
    if (!userToken) {
      throw new Error("User token is required");
    }

    const runner = this;
    const handler = {
      get: (target: this, prop: keyof this) => {
        const orig = target[prop];
        if (typeof orig === "function") {
          return (...args: any[]) => {
            runner._userToken = userToken;
            try {
              return orig.apply(runner, args);
            } finally {
              runner._userToken = undefined;
            }
          };
        }
        return orig;
      },
    };
    // @ts-ignore
    return new Proxy(this, handler) as WithInjectedToken<typeof this>;
  }

  protected get userToken(): string | undefined {
    return this._userToken;
  }

  // executes a method with the provided execution options + execution chain
  protected async executeMethod<T>(
    fn: () => Promise<T>,
    options: { default: ExecuteOptions; user?: ExecuteOptions }
  ): Promise<T | undefined> {
    const executeOptions = this._buildExecutionOptions(
      options.default,
      options?.user
    );

    let executionFn = fn;

    try {
      executionFn = this._buildExecutionChain(executionFn, executeOptions);
      return await executionFn();
    } catch (err) {
      // sdk should not crash
      return undefined;
    }
  }

  // builds the execution chain based on enabled core plugins
  protected _buildExecutionChain<T>(
    fn: () => Promise<T>,
    options: ExecuteOptions
  ) {
    const isCacheEnabled = options.cache?.enabled && options.cache?.cacheKey;

    let executionFn = fn;

    // 1. Cache       - Returns cached result if available
    // 2. Retry       - Retries on failure with exponential backoff
    // 3. Timeout     - Adds timeout limit (receives abort signal for cleanup)
    // 4. Abort       - Handles abort signals (user cancel or graceful shutdown)
    // 5. Transform   - Transforms the final result

    if (isCacheEnabled) {
      const cachedFn = executionFn;
      executionFn = () => this._executeWithCache(cachedFn, options.cache!);
    }

    return executionFn;
  }

  // builds the execution options based on prioritization
  protected _buildExecutionOptions(
    methodDefaults: ExecuteOptions,
    userOverride?: ExecuteOptions
  ): ExecuteOptions {
    // method defaults (lowest priority)
    let result = methodDefaults;

    // apply global config (medium priority)
    const globalConfig: Partial<ExecuteOptions> = {};
    Object.keys(methodDefaults).forEach((key) => {
      if (this.config[key]) {
        // @ts-ignore
        globalConfig[key as keyof ExecuteOptions] = this.config[key];
      }
    });

    if (Object.keys(globalConfig).length > 0) {
      result = deepMerge(result, globalConfig);
    }

    // apply user override (highest priority)
    if (userOverride) {
      result = deepMerge(result, userOverride);
    }

    return result;
  }

  private async _executeWithCache<T>(
    fn: () => Promise<T>,
    options: CacheConfig
  ) {
    const cacheKeyParts = options.cacheKey;

    // if no cache key parts, execute directly
    if (!cacheKeyParts || cacheKeyParts?.length === 0) {
      return fn();
    }

    const cacheKey = this.cache.generateKey(cacheKeyParts);

    // check cache
    const cached = this.cache.get<T>(cacheKey);
    if (cached !== null) {
      return cached;
    }

    // execute and cache
    const result = await fn();
    this.cache.set(cacheKey, result);

    return result;
  }
}
