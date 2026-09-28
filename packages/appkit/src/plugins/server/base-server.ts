import type express from "express";

import type { AppAnalyticsBrowserOptions } from "./types";
import {
  getAppAnalyticsScript,
  getConfigScript,
  type PluginClientConfigs,
  type PluginEndpoints,
} from "./utils";

/**
 * Base server for the AppKit.
 *
 * Abstract base class that provides common functionality for serving
 * frontend applications. Subclasses implement specific serving strategies
 * (Vite dev server, static file server, etc.).
 */
export abstract class BaseServer {
  protected app: express.Application;
  protected endpoints: PluginEndpoints;
  protected pluginConfigs: PluginClientConfigs;
  /**
   * Options for the auto-started App Analytics library, or `undefined` when
   * its script tag isn't injected.
   */
  protected appAnalytics?: AppAnalyticsBrowserOptions;

  constructor(
    app: express.Application,
    endpoints: PluginEndpoints = {},
    pluginConfigs: PluginClientConfigs = {},
    appAnalytics?: AppAnalyticsBrowserOptions,
  ) {
    this.app = app;
    this.endpoints = endpoints;
    this.pluginConfigs = pluginConfigs;
    this.appAnalytics = appAnalytics;
  }

  abstract setup(): void | Promise<void>;

  async close(): Promise<void> {}

  protected getConfigScript(): string {
    return getConfigScript(
      this.endpoints,
      this.pluginConfigs,
      this.appAnalytics,
    );
  }

  /** The App Analytics script tag, or an empty string when it isn't injected. */
  protected getAppAnalyticsScript(): string {
    return getAppAnalyticsScript(this.appAnalytics);
  }
}
