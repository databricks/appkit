import { Readable } from "node:stream";
import type express from "express";
import type { IAppRouter, PluginExecutionSettings } from "shared";
import { contentTypeFromPath, FilesConnector } from "../../connectors/files";
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
    });
  }

  async list(directoryPath?: string) {
    return this.filesConnector.list(getWorkspaceClient(), directoryPath);
  }

  async read(filePath: string) {
    return this.filesConnector.read(getWorkspaceClient(), filePath);
  }

  async download(filePath: string): Promise<DownloadResponse> {
    return this.filesConnector.download(getWorkspaceClient(), filePath);
  }

  async exists(filePath: string) {
    return this.filesConnector.exists(getWorkspaceClient(), filePath);
  }

  async metadata(filePath: string) {
    return this.filesConnector.metadata(getWorkspaceClient(), filePath);
  }

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

  async createDirectory(directoryPath: string) {
    return this.filesConnector.createDirectory(
      getWorkspaceClient(),
      directoryPath,
    );
  }

  async delete(filePath: string) {
    return this.filesConnector.delete(getWorkspaceClient(), filePath);
  }

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
      this._readSettings(["files:list", path ?? "__root__"]),
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
      this._readSettings(["files:read", path]),
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
      contentTypeFromPath(path) ?? "application/octet-stream",
    );
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

    res.setHeader(
      "Content-Type",
      contentTypeFromPath(path) ?? "application/octet-stream",
    );
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
      this._readSettings(["files:exists", path]),
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
      this._readSettings(["files:metadata", path]),
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
      this._readSettings(["files:preview", path]),
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
    this._invalidateListCache(parentDir);

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
    this._invalidateListCache(parentDir);

    res.json(result);
  }

  private async _handleDelete(
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
    this._invalidateListCache(parentDir);

    res.json(result);
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  exports() {
    return {
      list: this.list,
      read: this.read,
      download: this.download,
      exists: this.exists,
      metadata: this.metadata,
      upload: this.upload,
      createDirectory: this.createDirectory,
      delete: this.delete,
      preview: this.preview,
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
