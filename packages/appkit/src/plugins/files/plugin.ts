import { Readable } from "node:stream";
import { ApiError } from "@databricks/sdk-experimental";
import type express from "express";
import type { IAppRouter, PluginExecutionSettings } from "shared";
import {
  contentTypeFromPath,
  FilesConnector,
  isSafeInlineContentType,
  validateCustomContentTypes,
} from "../../connectors/files";
import { getWorkspaceClient, isInUserContext } from "../../context";
import { AuthenticationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest, ResourceRequirement } from "../../registry";
import { ResourceType } from "../../registry";
import {
  FILES_DOWNLOAD_DEFAULTS,
  FILES_MAX_UPLOAD_SIZE,
  FILES_READ_DEFAULTS,
  FILES_WRITE_DEFAULTS,
} from "./defaults";
import { parentDirectory, sanitizeFilename } from "./helpers";
import manifest from "./manifest.json";
import type {
  DownloadResponse,
  FilesExport,
  IFilesConfig,
  VolumeAPI,
  VolumeConfig,
  VolumeHandle,
} from "./types";

const logger = createLogger("files");

export class FilesPlugin extends Plugin {
  name = "files";

  /** Plugin manifest declaring metadata and resource requirements. */
  static manifest = manifest as PluginManifest;
  protected static description = "Files plugin for Databricks file operations";
  protected declare config: IFilesConfig;

  private volumeConnectors: Record<string, FilesConnector> = {};
  private volumeConfigs: Record<string, VolumeConfig> = {};
  private volumeKeys: string[] = [];

  /**
   * Scans `process.env` for `DATABRICKS_VOLUME_*` keys and merges them with
   * any explicitly configured volumes. Explicit config wins for per-volume
   * overrides; auto-discovered volumes get default `{}` config.
   */
  static discoverVolumes(config: IFilesConfig): Record<string, VolumeConfig> {
    const explicit = config.volumes ?? {};
    const discovered: Record<string, VolumeConfig> = {};

    const prefix = "DATABRICKS_VOLUME_";
    for (const key of Object.keys(process.env)) {
      if (!key.startsWith(prefix)) continue;
      const suffix = key.slice(prefix.length);
      if (!suffix) continue;
      if (!process.env[key]) continue;
      const volumeKey = suffix.toLowerCase();
      if (!(volumeKey in explicit)) {
        discovered[volumeKey] = {};
      }
    }

    return { ...discovered, ...explicit };
  }

  /**
   * Generates resource requirements dynamically from discovered + configured volumes.
   * Each volume key maps to a `DATABRICKS_VOLUME_{KEY_UPPERCASE}` env var.
   */
  static getResourceRequirements(config: IFilesConfig): ResourceRequirement[] {
    const volumes = FilesPlugin.discoverVolumes(config);
    return Object.keys(volumes).map((key) => ({
      type: ResourceType.VOLUME,
      alias: `volume-${key}`,
      resourceKey: `volume-${key}`,
      description: `Unity Catalog Volume for "${key}" file storage`,
      permission: "WRITE_VOLUME",
      fields: {
        path: {
          env: `DATABRICKS_VOLUME_${key.toUpperCase()}`,
          description: `Volume path for "${key}" (e.g. /Volumes/catalog/schema/volume_name)`,
        },
      },
      required: true,
    }));
  }

  /**
   * Warns when a method is called without a user context (i.e. as service principal).
   * OBO access via `asUser(req)` is strongly recommended.
   */
  private warnIfNoUserContext(volumeKey: string, method: string): void {
    if (!isInUserContext()) {
      logger.warn(
        `app.files("${volumeKey}").${method}() called without user context (service principal). ` +
          `Please use OBO instead: app.files("${volumeKey}").asUser(req).${method}()`,
      );
    }
  }

  /**
   * Throws when a method is called without a user context (i.e. as service principal).
   * OBO access via `asUser(req)` is enforced for now.
   */
  private throwIfNoUserContext(volumeKey: string, method: string): void {
    if (!isInUserContext()) {
      throw new Error(
        `app.files("${volumeKey}").${method}() called without user context (service principal). Use OBO instead: app.files("${volumeKey}").asUser(req).${method}()`,
      );
    }
  }

  constructor(config: IFilesConfig) {
    super(config);
    this.config = config;

    if (config.customContentTypes) {
      validateCustomContentTypes(config.customContentTypes);
    }

    const volumes = FilesPlugin.discoverVolumes(config);
    this.volumeKeys = Object.keys(volumes);

    for (const key of this.volumeKeys) {
      const volumeCfg = volumes[key];
      const envVar = `DATABRICKS_VOLUME_${key.toUpperCase()}`;
      const volumePath = process.env[envVar];

      // Merge per-volume config with plugin-level defaults
      const mergedConfig: VolumeConfig = {
        maxUploadSize: volumeCfg.maxUploadSize ?? config.maxUploadSize,
        customContentTypes:
          volumeCfg.customContentTypes ?? config.customContentTypes,
      };
      this.volumeConfigs[key] = mergedConfig;

      this.volumeConnectors[key] = new FilesConnector({
        defaultVolume: volumePath,
        timeout: config.timeout,
        telemetry: config.telemetry,
        customContentTypes: mergedConfig.customContentTypes,
      });
    }
  }

  /**
   * Creates a VolumeAPI for a specific volume key.
   * Each method warns if called outside a user context (service principal).
   */
  protected createVolumeAPI(volumeKey: string): VolumeAPI {
    const connector = this.volumeConnectors[volumeKey];
    return {
      list: (directoryPath?: string) => {
        this.throwIfNoUserContext(volumeKey, `list`);
        return connector.list(getWorkspaceClient(), directoryPath);
      },
      read: (filePath: string, options?: { maxSize?: number }) => {
        this.throwIfNoUserContext(volumeKey, `read`);
        return connector.read(getWorkspaceClient(), filePath, options);
      },
      download: (filePath: string): Promise<DownloadResponse> => {
        this.throwIfNoUserContext(volumeKey, `download`);
        return connector.download(getWorkspaceClient(), filePath);
      },
      exists: (filePath: string) => {
        this.throwIfNoUserContext(volumeKey, `exists`);
        return connector.exists(getWorkspaceClient(), filePath);
      },
      metadata: (filePath: string) => {
        this.throwIfNoUserContext(volumeKey, `metadata`);
        return connector.metadata(getWorkspaceClient(), filePath);
      },
      upload: (
        filePath: string,
        contents: ReadableStream | Buffer | string,
        options?: { overwrite?: boolean },
      ) => {
        this.throwIfNoUserContext(volumeKey, `upload`);
        return connector.upload(
          getWorkspaceClient(),
          filePath,
          contents,
          options,
        );
      },
      createDirectory: (directoryPath: string) => {
        this.throwIfNoUserContext(volumeKey, `createDirectory`);
        return connector.createDirectory(getWorkspaceClient(), directoryPath);
      },
      delete: (filePath: string) => {
        this.throwIfNoUserContext(volumeKey, `delete`);
        return connector.delete(getWorkspaceClient(), filePath);
      },
      preview: (filePath: string) => {
        this.throwIfNoUserContext(volumeKey, `preview`);
        return connector.preview(getWorkspaceClient(), filePath);
      },
    };
  }

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      name: "volumes",
      method: "get",
      path: "/volumes",
      handler: async (_req: express.Request, res: express.Response) => {
        res.json({ volumes: this.volumeKeys });
      },
    });

    this.route(router, {
      name: "list",
      method: "get",
      path: "/:volumeKey/list",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleList(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "read",
      method: "get",
      path: "/:volumeKey/read",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleRead(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "download",
      method: "get",
      path: "/:volumeKey/download",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleDownload(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "raw",
      method: "get",
      path: "/:volumeKey/raw",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleRaw(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "exists",
      method: "get",
      path: "/:volumeKey/exists",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleExists(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "metadata",
      method: "get",
      path: "/:volumeKey/metadata",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleMetadata(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "preview",
      method: "get",
      path: "/:volumeKey/preview",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handlePreview(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "upload",
      method: "post",
      path: "/:volumeKey/upload",
      skipBodyParsing: true,
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleUpload(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "mkdir",
      method: "post",
      path: "/:volumeKey/mkdir",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleMkdir(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "delete",
      method: "delete",
      path: "/:volumeKey",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleDelete(req, res, connector, volumeKey);
      },
    });
  }

  /**
   * Resolve `:volumeKey` from the request. Returns the connector and key,
   * or sends a 404 and returns `{ connector: undefined }`.
   */
  private _resolveVolume(
    req: express.Request,
    res: express.Response,
  ):
    | { connector: FilesConnector; volumeKey: string }
    | { connector: undefined; volumeKey: undefined } {
    const volumeKey = req.params.volumeKey;
    const connector = this.volumeConnectors[volumeKey];
    if (!connector) {
      const safeKey = volumeKey.replace(/[^a-zA-Z0-9_-]/g, "");
      res.status(404).json({
        error: `Unknown volume "${safeKey}"`,
        plugin: this.name,
      });
      return { connector: undefined, volumeKey: undefined };
    }
    return { connector, volumeKey };
  }

  /**
   * Validate a file/directory path from user input.
   * Returns `true` if valid, or an error message string if invalid.
   */
  private _isValidPath(path: string | undefined): true | string {
    if (!path) return "path is required";
    if (path.length > 4096)
      return `path exceeds maximum length of 4096 characters (got ${path.length})`;
    if (path.includes("\0")) return "path must not contain null bytes";
    return true;
  }

  private _readSettings(
    cacheKey: (string | number | object)[],
  ): PluginExecutionSettings {
    return {
      default: {
        ...FILES_READ_DEFAULTS,
        cache: { ...FILES_READ_DEFAULTS.cache, cacheKey },
      },
    };
  }

  /**
   * Invalidate cached list entries for a directory after a write operation.
   * Uses the same cache-key format as `_handleList`: resolved path for
   * subdirectories, `"__root__"` for the volume root.
   */
  private _invalidateListCache(
    volumeKey: string,
    parentPath: string,
    userId: string,
    connector: FilesConnector,
  ): void {
    const parent = parentDirectory(parentPath);
    const cachePathSegment = parent
      ? connector.resolvePath(parent)
      : "__root__";
    const listKey = this.cache.generateKey(
      [`files:${volumeKey}:list`, cachePathSegment],
      userId,
    );
    this.cache.delete(listKey);
  }

  private _handleApiError(
    res: express.Response,
    error: unknown,
    fallbackMessage: string,
  ): void {
    if (error instanceof AuthenticationError) {
      res.status(401).json({
        error: error.message,
        plugin: this.name,
      });
      return;
    }
    if (error instanceof ApiError) {
      const status = error.statusCode ?? 500;
      if (status >= 400 && status < 500) {
        res.status(status).json({
          error: error.message,
          statusCode: status,
          plugin: this.name,
        });
        return;
      }
      logger.error("Upstream server error in %s: %O", this.name, error);
      res.status(500).json({ error: fallbackMessage, plugin: this.name });
      return;
    }
    logger.error("Unhandled error in %s: %O", this.name, error);
    res.status(500).json({ error: fallbackMessage, plugin: this.name });
  }

  private async _handleList(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const path = req.query.path as string | undefined;

    try {
      const userPlugin = this.asUser(req);
      const result = await userPlugin.execute(
        async () => {
          this.warnIfNoUserContext(volumeKey, `list`);
          return connector.list(getWorkspaceClient(), path);
        },
        this._readSettings([
          `files:${volumeKey}:list`,
          path ? connector.resolvePath(path) : "__root__",
        ]),
      );

      if (result === undefined) {
        res.status(500).json({ error: "List failed", plugin: this.name });
        return;
      }
      res.json(result);
    } catch (error) {
      this._handleApiError(res, error, "List failed");
    }
  }

  private async _handleRead(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const path = req.query.path as string;
    const valid = this._isValidPath(path);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }

    try {
      const userPlugin = this.asUser(req);
      const result = await userPlugin.execute(
        async () => {
          this.warnIfNoUserContext(volumeKey, `read`);
          return connector.read(getWorkspaceClient(), path);
        },
        this._readSettings([
          `files:${volumeKey}:read`,
          connector.resolvePath(path),
        ]),
      );

      if (result === undefined) {
        res.status(500).json({ error: "Read failed", plugin: this.name });
        return;
      }
      res.type("text/plain").send(result);
    } catch (error) {
      this._handleApiError(res, error, "Read failed");
    }
  }

  private async _handleDownload(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    return this._serveFile(req, res, connector, volumeKey, {
      mode: "download",
    });
  }

  private async _handleRaw(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    return this._serveFile(req, res, connector, volumeKey, {
      mode: "raw",
    });
  }

  /**
   * Shared handler for `/download` and `/raw` endpoints.
   * - `download`: always forces `Content-Disposition: attachment`.
   * - `raw`: adds CSP sandbox; forces attachment only for unsafe content types.
   */
  private async _serveFile(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
    opts: { mode: "download" | "raw" },
  ): Promise<void> {
    const path = req.query.path as string;
    const valid = this._isValidPath(path);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }

    const label = opts.mode === "download" ? "Download" : "Raw fetch";
    const volumeCfg = this.volumeConfigs[volumeKey];

    try {
      const userPlugin = this.asUser(req);
      const settings: PluginExecutionSettings = {
        default: FILES_DOWNLOAD_DEFAULTS,
      };
      const response = await userPlugin.execute(async () => {
        this.warnIfNoUserContext(volumeKey, `download`);
        return connector.download(getWorkspaceClient(), path);
      }, settings);

      if (response === undefined) {
        res.status(500).json({ error: `${label} failed`, plugin: this.name });
        return;
      }

      const resolvedType = contentTypeFromPath(
        path,
        undefined,
        volumeCfg.customContentTypes,
      );
      const fileName = sanitizeFilename(path.split("/").pop() ?? "download");

      res.setHeader("Content-Type", resolvedType);
      res.setHeader("X-Content-Type-Options", "nosniff");

      if (opts.mode === "raw") {
        res.setHeader("Content-Security-Policy", "sandbox");
        if (!isSafeInlineContentType(resolvedType)) {
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${fileName}"`,
          );
        }
      } else {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${fileName}"`,
        );
      }

      if (response.contents) {
        const nodeStream = Readable.fromWeb(
          response.contents as import("node:stream/web").ReadableStream,
        );
        nodeStream.on("error", (err) => {
          logger.error("Stream error during %s: %O", opts.mode, err);
          if (!res.headersSent) {
            res
              .status(500)
              .json({ error: `${label} failed`, plugin: this.name });
          } else {
            res.destroy();
          }
        });
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      this._handleApiError(res, error, `${label} failed`);
    }
  }

  private async _handleExists(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const path = req.query.path as string;
    const valid = this._isValidPath(path);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }

    try {
      const userPlugin = this.asUser(req);
      const result = await userPlugin.execute(
        async () => {
          this.warnIfNoUserContext(volumeKey, `exists`);
          return connector.exists(getWorkspaceClient(), path);
        },
        this._readSettings([
          `files:${volumeKey}:exists`,
          connector.resolvePath(path),
        ]),
      );

      if (result === undefined) {
        res
          .status(500)
          .json({ error: "Exists check failed", plugin: this.name });
        return;
      }
      res.json({ exists: result });
    } catch (error) {
      this._handleApiError(res, error, "Exists check failed");
    }
  }

  private async _handleMetadata(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const path = req.query.path as string;
    const valid = this._isValidPath(path);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }

    try {
      const userPlugin = this.asUser(req);
      const result = await userPlugin.execute(
        async () => {
          this.warnIfNoUserContext(volumeKey, `metadata`);
          return connector.metadata(getWorkspaceClient(), path);
        },
        this._readSettings([
          `files:${volumeKey}:metadata`,
          connector.resolvePath(path),
        ]),
      );

      if (result === undefined) {
        res
          .status(500)
          .json({ error: "Metadata fetch failed", plugin: this.name });
        return;
      }
      res.json(result);
    } catch (error) {
      this._handleApiError(res, error, "Metadata fetch failed");
    }
  }

  private async _handlePreview(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const path = req.query.path as string;
    const valid = this._isValidPath(path);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }

    try {
      const userPlugin = this.asUser(req);
      const result = await userPlugin.execute(
        async () => {
          this.warnIfNoUserContext(volumeKey, `preview`);
          return connector.preview(getWorkspaceClient(), path);
        },
        this._readSettings([
          `files:${volumeKey}:preview`,
          connector.resolvePath(path),
        ]),
      );

      if (result === undefined) {
        res.status(500).json({ error: "Preview failed", plugin: this.name });
        return;
      }
      res.json(result);
    } catch (error) {
      this._handleApiError(res, error, "Preview failed");
    }
  }

  private async _handleUpload(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const path = req.query.path as string;
    const valid = this._isValidPath(path);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }

    const volumeCfg = this.volumeConfigs[volumeKey];
    const maxSize = volumeCfg.maxUploadSize ?? FILES_MAX_UPLOAD_SIZE;
    const rawContentLength = req.headers["content-length"];
    const contentLength = rawContentLength
      ? parseInt(rawContentLength, 10)
      : undefined;

    if (
      contentLength !== undefined &&
      !Number.isNaN(contentLength) &&
      contentLength > maxSize
    ) {
      res.status(413).json({
        error: `File size (${contentLength} bytes) exceeds maximum allowed size (${maxSize} bytes).`,
        plugin: this.name,
      });
      return;
    }

    logger.debug(req, "Upload started: volume=%s path=%s", volumeKey, path);

    try {
      const rawStream: ReadableStream<Uint8Array> = Readable.toWeb(req);

      let bytesReceived = 0;
      const webStream = rawStream.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytesReceived += chunk.byteLength;
            if (bytesReceived > maxSize) {
              controller.error(
                new Error(
                  `Upload stream exceeds maximum allowed size (${maxSize} bytes)`,
                ),
              );
              return;
            }
            controller.enqueue(chunk);
          },
        }),
      );

      logger.debug(
        req,
        "Upload body received: volume=%s path=%s, size=%d bytes",
        volumeKey,
        path,
        contentLength ?? 0,
      );
      const userPlugin = this.asUser(req);
      const settings: PluginExecutionSettings = {
        default: FILES_WRITE_DEFAULTS,
      };
      const result = await this.trackWrite(() =>
        userPlugin.execute(async () => {
          this.warnIfNoUserContext(volumeKey, `upload`);
          await connector.upload(getWorkspaceClient(), path, webStream);
          return { success: true as const };
        }, settings),
      );

      this._invalidateListCache(
        volumeKey,
        path,
        this.resolveUserId(req),
        connector,
      );

      if (result === undefined) {
        logger.error(
          req,
          "Upload failed: volume=%s path=%s, size=%d bytes",
          volumeKey,
          path,
          contentLength ?? 0,
        );
        res.status(500).json({ error: "Upload failed", plugin: this.name });
        return;
      }

      logger.debug(req, "Upload complete: volume=%s path=%s", volumeKey, path);
      res.json(result);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("exceeds maximum allowed size")
      ) {
        res.status(413).json({ error: error.message, plugin: this.name });
        return;
      }
      this._handleApiError(res, error, "Upload failed");
    }
  }

  private async _handleMkdir(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const dirPath =
      typeof req.body?.path === "string" ? req.body.path : undefined;
    const valid = this._isValidPath(dirPath);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }

    try {
      const userPlugin = this.asUser(req);
      const settings: PluginExecutionSettings = {
        default: FILES_WRITE_DEFAULTS,
      };
      const result = await this.trackWrite(() =>
        userPlugin.execute(async () => {
          this.warnIfNoUserContext(volumeKey, `createDirectory`);
          await connector.createDirectory(getWorkspaceClient(), dirPath);
          return { success: true as const };
        }, settings),
      );

      this._invalidateListCache(
        volumeKey,
        dirPath,
        this.resolveUserId(req),
        connector,
      );

      if (result === undefined) {
        res
          .status(500)
          .json({ error: "Create directory failed", plugin: this.name });
        return;
      }

      res.json(result);
    } catch (error) {
      this._handleApiError(res, error, "Create directory failed");
    }
  }

  private async _handleDelete(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const rawPath = req.query.path as string | undefined;
    const valid = this._isValidPath(rawPath);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }
    const path = rawPath as string;

    try {
      const userPlugin = this.asUser(req);
      const settings: PluginExecutionSettings = {
        default: FILES_WRITE_DEFAULTS,
      };
      const result = await this.trackWrite(() =>
        userPlugin.execute(async () => {
          this.warnIfNoUserContext(volumeKey, `delete`);
          await connector.delete(getWorkspaceClient(), path);
          return { success: true as const };
        }, settings),
      );

      this._invalidateListCache(
        volumeKey,
        path,
        this.resolveUserId(req),
        connector,
      );

      if (result === undefined) {
        res.status(500).json({ error: "Delete failed", plugin: this.name });
        return;
      }

      res.json(result);
    } catch (error) {
      this._handleApiError(res, error, "Delete failed");
    }
  }

  private inflightWrites = 0;

  private trackWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.inflightWrites++;
    return fn().finally(() => {
      this.inflightWrites--;
    });
  }

  async shutdown(): Promise<void> {
    // Wait up to 10 seconds for in-flight write operations to finish
    const deadline = Date.now() + 10_000;
    while (this.inflightWrites > 0 && Date.now() < deadline) {
      logger.info(
        "Waiting for %d in-flight write(s) to complete before shutdown…",
        this.inflightWrites,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (this.inflightWrites > 0) {
      logger.warn(
        "Shutdown deadline reached with %d in-flight write(s) still pending.",
        this.inflightWrites,
      );
    }
    this.streamManager.abortAll();
  }

  /**
   * Returns the programmatic API for the Files plugin.
   * Callable with a volume key to get a volume-scoped handle.
   *
   * @example
   * ```ts
   * // OBO access (recommended)
   * appKit.files("uploads").asUser(req).list()
   *
   * // Service principal access (logs a warning)
   * appKit.files("uploads").list()
   * ```
   */
  exports(): FilesExport {
    const resolveVolume = (volumeKey: string): VolumeHandle => {
      if (!this.volumeKeys.includes(volumeKey)) {
        throw new Error(
          `Unknown volume "${volumeKey}". Available volumes: ${this.volumeKeys.join(", ")}`,
        );
      }

      // Service principal API — each method logs a warning recommending OBO
      const spApi = this.createVolumeAPI(volumeKey);

      return {
        ...spApi,
        asUser: (req: import("express").Request) => {
          const userPlugin = this.asUser(req) as FilesPlugin;
          return userPlugin.createVolumeAPI(volumeKey);
        },
      };
    };

    const filesExport = ((volumeKey: string) =>
      resolveVolume(volumeKey)) as FilesExport;
    filesExport.volume = resolveVolume;

    return filesExport;
  }
}

/**
 * @internal
 */
export const files = toPlugin(FilesPlugin);
