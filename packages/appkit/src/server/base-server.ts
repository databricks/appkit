import type express from "express";
import { type PluginEndpoints, getConfigScript } from "./utils";

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

  constructor(app: express.Application, endpoints: PluginEndpoints = {}) {
    this.app = app;
    this.endpoints = endpoints;
  }

  abstract setup(): void | Promise<void>;

  async close(): Promise<void> {}

  protected getConfigScript(): string {
    return getConfigScript(this.endpoints);
  }
}
