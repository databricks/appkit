import type { BasePluginConfig } from "shared";

export interface ServerConfig extends BasePluginConfig {
  port?: number;
  staticPath?: string;
  host?: string;
  /**
   * Max request body size accepted by the built-in `express.json()`
   * middleware. Accepts any string the `bytes` library understands
   * (`"1mb"`, `"10mb"`, `"512kb"`, …). Defaults to `"1mb"` — high enough
   * for agent chat payloads and modest base64 uploads (the dev
   * playground's smart-dashboard "save view" screenshot is the
   * motivating case), low enough that an attacker can't trivially
   * exhaust memory by spamming oversized JSON. Raise it explicitly if
   * your app routinely posts larger JSON bodies.
   */
  bodyLimit?: string;
  /**
   * App Analytics, the browser usage and experience telemetry. Defaults to
   * `true`, which does two things:
   *
   * - Serves the relay at `POST /_analytics/v1/logs`, the default endpoint of
   *   the App Analytics browser library. It accepts OTLP logs JSON bodies up
   *   to 64 KiB and 100 records, and forwards them unchanged to the
   *   Databricks Apps OTel Collector. It counts its outcomes in the
   *   `app_analytics.relay.requests` metric.
   * - When App telemetry is on (`OTEL_EXPORTER_OTLP_ENDPOINT` or
   *   `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is set), adds a script tag for
   *   `/_analytics/v1/sdk.js` to every `index.html` the server returns. That
   *   build of the library starts on its own and records page views with no
   *   client code.
   *
   * Pass an object to set the options of that auto-started library. Options
   * an app passes to `<AppAnalytics />` or `appAnalytics.init()` merge over
   * them.
   *
   * Set to `false` to remove both the relay and the script tag, for example
   * to mount your own relay at another path with `server.extend()`.
   */
  appAnalytics?: boolean | AppAnalyticsBrowserOptions;
}

/**
 * Options of the App Analytics library that the server plugin starts in the
 * page when App telemetry is on. They reach the page through
 * `window.__appkit__.appAnalytics`.
 */
export interface AppAnalyticsBrowserOptions {
  /** Record LCP, INP, CLS, FCP, and TTFB. Defaults to `false`. */
  webVitals?: boolean;
  /**
   * Record clicks and submits on elements annotated with
   * `data-app-analytics-event`. Defaults to `true`; nothing is recorded until
   * an element carries the annotation.
   */
  autocapture?: boolean;
  /** Fraction of browser sessions to collect, from 0 to 1. Defaults to `1`. */
  sampleRate?: number;
}
