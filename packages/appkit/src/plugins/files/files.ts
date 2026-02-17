import type { IAppRouter } from "shared";
import { getWorkspaceClient } from "../../context";
import { Plugin, toPlugin } from "../../plugin";
import { FilesClient } from "./lib";
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
  }

  /**
   * Create a FilesClient scoped to the current execution context.
   * Must be called per-request so `asUser()` context is respected.
   */
  private getFilesClient(): FilesClient {
    const client = getWorkspaceClient();
    return new FilesClient({
      defaultVolume: this.config.defaultVolume,
      client,
    });
  }

  injectRoutes(_router: IAppRouter) {
    // Routes are handled in the app layer via server.extend()
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  /**
   * Returns the public exports for the files plugin.
   * Note: `asUser()` is automatically added by AppKit.
   */
  exports() {
    return {
      list: (directoryPath?: string) =>
        this.getFilesClient().list(directoryPath),
      read: (filePath: string) => this.getFilesClient().read(filePath),
      download: (filePath: string) => this.getFilesClient().download(filePath),
      exists: (filePath: string) => this.getFilesClient().exists(filePath),
      metadata: (filePath: string) => this.getFilesClient().metadata(filePath),
      upload: (
        filePath: string,
        contents: ReadableStream | Buffer | string,
        options?: { overwrite?: boolean },
      ) => this.getFilesClient().upload(filePath, contents, options),
      createDirectory: (directoryPath: string) =>
        this.getFilesClient().createDirectory(directoryPath),
      delete: (filePath: string) => this.getFilesClient().delete(filePath),
      preview: (filePath: string) => this.getFilesClient().preview(filePath),
    };
  }
}

/**
 * @internal
 */
export const files = toPlugin<typeof FilesPlugin, IFilesConfig, "files">(
  FilesPlugin,
  "files",
);
