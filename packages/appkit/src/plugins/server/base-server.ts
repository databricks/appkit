import type express from "express";
import {
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

  constructor(
    app: express.Application,
    endpoints: PluginEndpoints = {},
    pluginConfigs: PluginClientConfigs = {},
  ) {
    this.app = app;
    this.endpoints = endpoints;
    this.pluginConfigs = pluginConfigs;
  }

  abstract setup(): void | Promise<void>;

  async close(): Promise<void> {}

  protected getConfigScript(): string {
    return getConfigScript(this.endpoints, this.pluginConfigs);
  }
}
