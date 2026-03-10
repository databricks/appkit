import type { PluginClientConfigs, PluginEndpoints } from "shared";

export interface AppKitClientConfig {
  appName: string;
  queries: Record<string, string>;
  endpoints: PluginEndpoints;
  plugins: PluginClientConfigs;
}

declare global {
  interface Window {
    __appkit__?: AppKitClientConfig;
  }
}

const APPKIT_CONFIG_SCRIPT_ID = "__appkit__";
const EMPTY_CONFIG: AppKitClientConfig = Object.freeze({
  appName: "",
  queries: Object.freeze({}),
  endpoints: Object.freeze({}),
  plugins: Object.freeze({}),
});

function normalizeClientConfig(config: unknown): AppKitClientConfig {
  if (!config || typeof config !== "object") {
    return EMPTY_CONFIG;
  }

  const normalized = config as Partial<AppKitClientConfig>;

  return {
    appName: normalized.appName ?? EMPTY_CONFIG.appName,
    queries: normalized.queries ?? EMPTY_CONFIG.queries,
    endpoints: normalized.endpoints ?? EMPTY_CONFIG.endpoints,
    plugins: normalized.plugins ?? EMPTY_CONFIG.plugins,
  };
}

function readClientConfigFromDom(): AppKitClientConfig {
  if (typeof document === "undefined") {
    return EMPTY_CONFIG;
  }

  const configScript = document.getElementById(APPKIT_CONFIG_SCRIPT_ID);
  if (!configScript?.textContent) {
    return EMPTY_CONFIG;
  }

  try {
    return normalizeClientConfig(JSON.parse(configScript.textContent));
  } catch (error) {
    console.warn("[appkit] Failed to parse config from DOM:", error);
    return EMPTY_CONFIG;
  }
}

let _cache: AppKitClientConfig | undefined;

/**
 * @internal Reset the module-scoped config cache. Test utility only.
 */
export function _resetConfigCache(): void {
  _cache = undefined;
}

export function getClientConfig(): AppKitClientConfig {
  if (typeof window === "undefined") {
    return EMPTY_CONFIG;
  }

  if (!_cache) {
    _cache = window.__appkit__ ?? readClientConfigFromDom();
  }

  return _cache;
}

const EMPTY_PLUGIN_CONFIG = Object.freeze({});

export function getPluginClientConfig<T = Record<string, unknown>>(
  pluginName: string,
): T {
  return (getClientConfig().plugins[pluginName] ?? EMPTY_PLUGIN_CONFIG) as T;
}
