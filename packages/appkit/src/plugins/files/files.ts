import type { IAppRouter } from "shared";
import { Plugin, toPlugin } from "../../plugin";
import { filesManifest } from "./manifest";
import type { IFilesConfig } from "./types";

export class FilesPlugin extends Plugin {
  name = "files";

  /** Plugin manifest declaring metadata and resource requirements */
  static manifest = filesManifest;

  protected static description = "Files plugin for Databricks file operations";
  protected declare config: IFilesConfig;

  constructor(config: IFilesConfig) {
    super(config);
    this.config = config;
    // TODO: Initialize file operation services
  }

  injectRoutes(_router: IAppRouter) {
    // TODO: Register file operation routes
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  exports() {
    // TODO: Return public API methods
    return {};
  }
}

/**
 * @internal
 */
export const files = toPlugin<typeof FilesPlugin, IFilesConfig, "files">(
  FilesPlugin,
  "files",
);
