import { Readable } from "node:stream";
import type express from "express";
import type { IAppRouter, PluginExecutionSettings } from "shared";
import {
  contentTypeFromPath,
  FilesConnector,
  isSafeInlineContentType,
} from "../../connectors/files";
import { getCurrentUserId, getWorkspaceClient } from "../../context";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import {
  filesDownloadDefaults,
  filesReadDefaults,
  filesWriteDefaults,
} from "./defaults";
import { filesManifest } from "./manifest";
import type { DownloadResponse, IFilesConfig } from "./types";

const logger = createLogger("files");

export class FilesPlugin extends Plugin {
  name = "files";

  /** Plugin manifest declaring metadata and resource requirements. */
  static manifest = filesManifest;
  protected static description = "Files plugin for Databricks file operations";
  protected declare config: IFilesConfig;

  private filesConnector: FilesConnector;

  constructor(config: IFilesConfig) {
    super(config);
    this.config = config;
    this.filesConnector = new FilesConnector({
      defaultVolume: config.defaultVolume,
      timeout: config.timeout,
      telemetry: config.telemetry,
      customContentTypes: config.customContentTypes,
    });
  }

  /**
   * List entries in a directory.
   *
   * @param directoryPath - Absolute or relative path. Defaults to the configured `defaultVolume` root.
   * @returns Array of directory entries.
   */
  async list(directoryPath?: string) {
    return this.filesConnector.list(getWorkspaceClient(), directoryPath);
  }

  /**
   * Read a file and return its contents as a string.
   *
   * @param filePath - Absolute or relative path to the file.
   * @returns The file contents as a UTF-8 string.
   */
  async read(filePath: string) {
    return this.filesConnector.read(getWorkspaceClient(), filePath);
  }

  /**
   * Download a file as a readable stream.
   *
   * @param filePath - Absolute or relative path to the file.
   * @returns A response containing a readable stream of the file contents.
   */
  async download(filePath: string): Promise<DownloadResponse> {
    return this.filesConnector.download(getWorkspaceClient(), filePath);
  }

  /**
   * Check whether a file exists.
   *
   * @param filePath - Absolute or relative path to the file.
   * @returns `true` if the file exists, `false` otherwise.
   */
  async exists(filePath: string) {
    return this.filesConnector.exists(getWorkspaceClient(), filePath);
  }

  /**
   * Retrieve metadata (size, content type, last modified) for a file.
   *
   * @param filePath - Absolute or relative path to the file.
   * @returns File metadata including content length, type, and last modified date.
   */
  async metadata(filePath: string) {
    return this.filesConnector.metadata(getWorkspaceClient(), filePath);
  }

  /**
   * Upload a file to a Unity Catalog volume.
   *
   * @param filePath - Absolute or relative destination path.
   * @param contents - File body as a readable stream, Buffer, or string.
   * @param options - Upload options.
   * @param options.overwrite - When `true`, overwrite an existing file at the same path.
   */
  async upload(
    filePath: string,
    contents: ReadableStream | Buffer | string,
    options?: { overwrite?: boolean },
  ) {
    return this.filesConnector.upload(
      getWorkspaceClient(),
      filePath,
      contents,
      options,
    );
  }

  /**
   * Create a directory in a Unity Catalog volume.
   *
   * @param directoryPath - Absolute or relative path for the new directory.
   */
  async createDirectory(directoryPath: string) {
    return this.filesConnector.createDirectory(
      getWorkspaceClient(),
      directoryPath,
    );
  }

  /**
   * Delete a file or directory from a Unity Catalog volume.
   *
   * @param filePath - Absolute or relative path to the file or directory.
   */
  async delete(filePath: string) {
    return this.filesConnector.delete(getWorkspaceClient(), filePath);
  }

  /**
   * Get a preview of a file including metadata and a text excerpt.
   *
   * @param filePath - Absolute or relative path to the file.
   * @returns Preview with metadata, text content hint, and format flags.
   */
  async preview(filePath: string) {
    return this.filesConnector.preview(getWorkspaceClient(), filePath);
  }

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      name: "root",
      method: "get",
      path: "/root",
      handler: async (_req: express.Request, res: express.Response) => {
        res.json({ root: this.config.defaultVolume ?? null });
      },
    });

    this.route(router, {
      name: "list",
      method: "get",
      path: "/list",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleList(req, res);
      },
    });

    this.route(router, {
      name: "read",
      method: "get",
      path: "/read",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleRead(req, res);
      },
    });

    this.route(router, {
      name: "download",
      method: "get",
      path: "/download",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleDownload(req, res);
      },
    });

    this.route(router, {
      name: "raw",
      method: "get",
      path: "/raw",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleRaw(req, res);
      },
    });

    this.route(router, {
      name: "exists",
      method: "get",
      path: "/exists",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleExists(req, res);
      },
    });

    this.route(router, {
      name: "metadata",
      method: "get",
      path: "/metadata",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleMetadata(req, res);
      },
    });

    this.route(router, {
      name: "preview",
      method: "get",
      path: "/preview",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handlePreview(req, res);
      },
    });

    this.route(router, {
      name: "upload",
      method: "post",
      path: "/upload",
      skipBodyParsing: true,
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleUpload(req, res);
      },
    });

    this.route(router, {
      name: "mkdir",
      method: "post",
      path: "/mkdir",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleMkdir(req, res);
      },
    });

    this.route(router, {
      name: "delete",
      method: "post",
      path: "/delete",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleDelete(req, res);
      },
    });
  }

  private _readSettings(
    cacheKey: (string | number | object)[],
  ): PluginExecutionSettings {
    return {
      default: {
        ...filesReadDefaults,
        cache: { ...filesReadDefaults.cache, cacheKey },
      },
    };
  }

  private _resolvePath(path: string): string {
    return this.filesConnector.resolvePath(path);
  }

  /**
   * Invalidate cached list entries for a directory after a write operation.
   */
  private _invalidateListCache(directoryPath: string): void {
    const userKey = getCurrentUserId();
    const listKey = this.cache.generateKey(
      ["files:list", directoryPath],
      userKey,
    );
    this.cache.delete(listKey);
  }

  private async _handleList(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const path = req.query.path as string | undefined;
    const executor = this.asUser(req);

    const result = await executor.execute(
      async () => executor.list(path),
      this._readSettings([
        "files:list",
        path ? this._resolvePath(path) : "__root__",
      ]),
    );

    if (result === undefined) {
      res.status(500).json({ error: "List failed", plugin: this.name });
      return;
    }
    res.json(result);
  }

  private async _handleRead(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const path = req.query.path as string;
    if (!path) {
      res.status(400).json({ error: "path is required", plugin: this.name });
      return;
    }

    const executor = this.asUser(req);
    const result = await executor.execute(
      async () => executor.read(path),
      this._readSettings(["files:read", this._resolvePath(path)]),
    );

    if (result === undefined) {
      res.status(500).json({ error: "Read failed", plugin: this.name });
      return;
    }
    res.type("text/plain").send(result);
  }

  private async _handleDownload(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const path = req.query.path as string;
    if (!path) {
      res.status(400).json({ error: "path is required", plugin: this.name });
      return;
    }

    const executor = this.asUser(req);
    const settings: PluginExecutionSettings = {
      default: filesDownloadDefaults,
    };
    const response = await executor.execute(
      async () => executor.download(path),
      settings,
    );

    if (response === undefined) {
      res.status(500).json({ error: "Download failed", plugin: this.name });
      return;
    }

    const fileName = path.split("/").pop() ?? "download";
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader(
      "Content-Type",
      contentTypeFromPath(path, undefined, this.config.customContentTypes),
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (response.contents) {
      const nodeStream = Readable.fromWeb(
        response.contents as import("node:stream/web").ReadableStream,
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  }

  private async _handleRaw(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const path = req.query.path as string;
    if (!path) {
      res.status(400).json({ error: "path is required", plugin: this.name });
      return;
    }

    const executor = this.asUser(req);
    const settings: PluginExecutionSettings = {
      default: filesDownloadDefaults,
    };
    const response = await executor.execute(
      async () => executor.download(path),
      settings,
    );

    if (response === undefined) {
      res.status(500).json({ error: "Raw fetch failed", plugin: this.name });
      return;
    }

    const resolvedType = contentTypeFromPath(
      path,
      undefined,
      this.config.customContentTypes,
    );

    res.setHeader("Content-Type", resolvedType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox");

    if (!isSafeInlineContentType(resolvedType)) {
      const fileName = path.split("/").pop() ?? "download";
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`,
      );
    }

    if (response.contents) {
      const nodeStream = Readable.fromWeb(
        response.contents as import("node:stream/web").ReadableStream,
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  }

  private async _handleExists(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const path = req.query.path as string;
    if (!path) {
      res.status(400).json({ error: "path is required", plugin: this.name });
      return;
    }

    const executor = this.asUser(req);
    const result = await executor.execute(
      async () => executor.exists(path),
      this._readSettings(["files:exists", this._resolvePath(path)]),
    );

    if (result === undefined) {
      res.status(500).json({ error: "Exists check failed", plugin: this.name });
      return;
    }
    res.json({ exists: result });
  }

  private async _handleMetadata(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const path = req.query.path as string;
    if (!path) {
      res.status(400).json({ error: "path is required", plugin: this.name });
      return;
    }

    const executor = this.asUser(req);
    const result = await executor.execute(
      async () => executor.metadata(path),
      this._readSettings(["files:metadata", this._resolvePath(path)]),
    );

    if (result === undefined) {
      res
        .status(500)
        .json({ error: "Metadata fetch failed", plugin: this.name });
      return;
    }
    res.json(result);
  }

  private async _handlePreview(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const path = req.query.path as string;
    if (!path) {
      res.status(400).json({ error: "path is required", plugin: this.name });
      return;
    }

    const executor = this.asUser(req);
    const result = await executor.execute(
      async () => executor.preview(path),
      this._readSettings(["files:preview", this._resolvePath(path)]),
    );

    if (result === undefined) {
      res.status(500).json({ error: "Preview failed", plugin: this.name });
      return;
    }
    res.json(result);
  }

  private async _handleUpload(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const path = req.query.path as string;
    if (!path) {
      res.status(400).json({ error: "path is required", plugin: this.name });
      return;
    }

    logger.debug(req, "Upload started: path=%s", path);

    const webStream: ReadableStream<Uint8Array> = Readable.toWeb(req);

    logger.debug(
      req,
      "Upload body received: path=%s, size=%d bytes",
      path,
      req.headers["content-length"]
        ? parseInt(req.headers["content-length"], 10)
        : 0,
    );

    const executor = this.asUser(req);
    const settings: PluginExecutionSettings = {
      default: filesWriteDefaults,
    };
    const result = await executor.execute(async () => {
      await executor.upload(path, webStream);
      return { success: true as const };
    }, settings);

    if (result === undefined) {
      logger.error(
        req,
        "Upload failed: path=%s, size=%d bytes",
        path,
        req.headers["content-length"]
          ? parseInt(req.headers["content-length"], 10)
          : 0,
      );
      res.status(500).json({ error: "Upload failed", plugin: this.name });
      return;
    }

    const parentDir = path.substring(0, path.lastIndexOf("/")) || path;
    this._invalidateListCache(this._resolvePath(parentDir));

    logger.debug(req, "Upload complete: path=%s", path);
    res.json(result);
  }

  private async _handleMkdir(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const dirPath = req.body?.path as string;
    if (!dirPath) {
      res.status(400).json({ error: "path is required", plugin: this.name });
      return;
    }

    const executor = this.asUser(req);
    const settings: PluginExecutionSettings = {
      default: filesWriteDefaults,
    };
    const result = await executor.execute(async () => {
      await executor.createDirectory(dirPath);
      return { success: true as const };
    }, settings);

    if (result === undefined) {
      res
        .status(500)
        .json({ error: "Create directory failed", plugin: this.name });
      return;
    }

    const parentDir = dirPath.substring(0, dirPath.lastIndexOf("/")) || dirPath;
    this._invalidateListCache(this._resolvePath(parentDir));

    res.json(result);
  }

  private async _handleDelete(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const path = req.body?.path as string;
    if (!path) {
      res.status(400).json({ error: "path is required", plugin: this.name });
      return;
    }

    const executor = this.asUser(req);
    const settings: PluginExecutionSettings = {
      default: filesWriteDefaults,
    };
    const result = await executor.execute(async () => {
      await executor.delete(path);
      return { success: true as const };
    }, settings);

    if (result === undefined) {
      res.status(500).json({ error: "Delete failed", plugin: this.name });
      return;
    }

    const parentDir = path.substring(0, path.lastIndexOf("/")) || path;
    this._invalidateListCache(this._resolvePath(parentDir));

    res.json(result);
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  /**
   * Returns the programmatic API for the Files plugin.
   * Note: `asUser()` is automatically added by AppKit.
   */
  exports() {
    return {
      /** List entries in a directory. */
      list: this.list,
      /** Read a file as a string. */
      read: this.read,
      /** Download a file as a readable stream. */
      download: this.download,
      /** Check whether a file exists. */
      exists: this.exists,
      /** Retrieve file metadata. */
      metadata: this.metadata,
      /** Upload a file. */
      upload: this.upload,
      /** Create a directory. */
      createDirectory: this.createDirectory,
      /** Delete a file or directory. */
      delete: this.delete,
      /** Get a file preview with text excerpt. */
      preview: this.preview,
    };
  }
}

/**
 * Files plugin for Databricks Unity Catalog volume operations.
 *
 * Provides HTTP routes and a programmatic API for listing, reading,
 * downloading, uploading, deleting, and previewing files with built-in
 * caching, retry, and timeout handling via the execution interceptor pipeline.
 *
 * Routes are mounted at `/api/files/*`.
 *
 * @example
 * ```typescript
 * import { createApp, files } from "@databricks/appkit";
 *
 * const app = await createApp({
 *   plugins: [
 *     files({ defaultVolume: "/Volumes/catalog/schema/vol" }),
 *   ],
 * });
 * ```
 */

/**
 * @internal
 */
export const files = toPlugin<typeof FilesPlugin, IFilesConfig, "files">(
  FilesPlugin,
  "files",
);
