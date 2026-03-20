import type express from "express";
import { injectBootstrapIntoHtml, type ServerBootstrapPayload } from "./utils";

/**
 * Base server for the AppKit.
 *
 * Abstract base class that provides common functionality for serving
 * frontend applications. Subclasses implement specific serving strategies
 * (Vite dev server, static file server, etc.).
 */
export abstract class BaseServer {
  protected app: express.Application;
  protected bootstrap: ServerBootstrapPayload;

  constructor(
    app: express.Application,
    bootstrap: ServerBootstrapPayload = {
      endpoints: {},
      runtimeConfig: {},
      contributions: [],
    },
  ) {
    this.app = app;
    this.bootstrap = bootstrap;
  }

  abstract setup(): void | Promise<void>;

  async close(): Promise<void> {}

  protected injectBootstrap(html: string): string {
    return injectBootstrapIntoHtml(html, this.bootstrap);
  }
}
