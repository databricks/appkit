/**
 * Entry of the self-contained browser build, `dist/browser/sdk.js`. The
 * AppKit server plugin serves that file and adds it to `index.html` when App
 * telemetry is on, next to the `window.__appkit__` runtime config. Loading it
 * starts the tab's default client with the options in
 * `window.__appkit__.appAnalytics`, so records flow with no client code.
 */
import {
  appAnalytics,
  isDefaultClientConfigured,
  type AppAnalyticsOptions,
} from "./client";

/** The options AppKit passes through `window.__appkit__.appAnalytics`. */
type InjectedOptions = Pick<
  AppAnalyticsOptions,
  "autocapture" | "sampleRate" | "webVitals"
>;

/**
 * Starts the default client from the injected config. Does nothing when there
 * is no config, or when the app has already called `appAnalytics.init()`, for
 * example through `<AppAnalytics />`. An app's own `init()` call made later
 * merges over these options, so every option the app sets wins in either
 * order.
 */
function startFromAppKitConfig(): void {
  try {
    const options = readInjectedOptions();
    if (options === undefined || isDefaultClientConfigured()) return;
    appAnalytics.init(options);
  } catch {
    // Instrumentation must not change the behavior of the host application.
  }
}

function readInjectedOptions(): InjectedOptions | undefined {
  if (typeof window === "undefined") return undefined;

  const runtimeConfig: unknown = Reflect.get(window, "__appkit__");
  if (!isRecord(runtimeConfig)) return undefined;
  const injected = runtimeConfig.appAnalytics;
  if (!isRecord(injected)) return undefined;

  const options: InjectedOptions = {};
  if (typeof injected.autocapture === "boolean") {
    options.autocapture = injected.autocapture;
  }
  if (typeof injected.sampleRate === "number") {
    options.sampleRate = injected.sampleRate;
  }
  if (typeof injected.webVitals === "boolean") {
    options.webVitals = injected.webVitals;
  }
  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

startFromAppKitConfig();
