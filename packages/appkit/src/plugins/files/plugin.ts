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
import { getCurrentUserId, getWorkspaceClient } from "../../context";
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
import {
  type FileAction,
  type FilePolicyUser,
  type FileResource,
  PolicyDeniedError,
  policy,
} from "./policy";
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

  /** Whether a volume has a policy attached. */
  private _hasPolicy(volumeKey: string): boolean {
    return typeof this.volumeConfigs[volumeKey]?.policy === "function";
  }

  /**
   * Extract user identity from the request.
   * Falls back to `getCurrentUserId()` in development mode.
   */
  private _extractUser(req: import("express").Request): FilePolicyUser {
    const userId = req.header("x-forwarded-user");
    if (userId) return { id: userId };
    if (process.env.NODE_ENV === "development") {
      logger.warn(
        "No x-forwarded-user header — falling back to service principal identity for policy checks. " +
          "Ensure your proxy forwards user headers to test per-user policies.",
      );
      return { id: getCurrentUserId() };
    }
    throw AuthenticationError.missingUserId();
  }

  /**
   * Check the policy for a volume. No-op if no policy is configured.
   * Throws `PolicyDeniedError` if denied.
   */
  private async _checkPolicy(
    volumeKey: string,
    action: FileAction,
    path: string,
    user: FilePolicyUser,
    resourceOverrides?: Partial<FileResource>,
  ): Promise<void> {
    const policyFn = this.volumeConfigs[volumeKey]?.policy;
    if (typeof policyFn !== "function") return;

    const resource: FileResource = {
      path,
      volume: volumeKey,
      ...resourceOverrides,
    };
    const allowed = await policyFn(action, resource, user);
    if (!allowed) {
      try {
        logger.warn(
          'Policy denied "%s" on volume "%s" for user "%s"',
          action,
          volumeKey,
          user.id,
        );
      } catch {
        // user.id may not be resolvable in all contexts (e.g. lazy SP getter)
        logger.warn('Policy denied "%s" on volume "%s"', action, volumeKey);
      }
      throw new PolicyDeniedError(action, volumeKey);
    }
  }

  /**
   * HTTP-level wrapper around `_checkPolicy`.
   * Extracts user (401 on failure), runs policy (403 on denial).
   * Returns `true` if the request may proceed, `false` if a response was sent.
   */
  private async _enforcePolicy(
    req: import("express").Request,
    res: import("express").Response,
    volumeKey: string,
    action: FileAction,
    resourceOverrides?: Partial<FileResource>,
  ): Promise<boolean> {
    if (!this._hasPolicy(volumeKey)) return true;

    let user: FilePolicyUser;
    try {
      user = this._extractUser(req);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        res.status(401).json({ error: error.message, plugin: this.name });
        return false;
      }
      throw error;
    }

    const path =
      (req.query.path as string | undefined) ??
      (typeof req.body?.path === "string" ? req.body.path : undefined) ??
      "/";

    try {
      await this._checkPolicy(volumeKey, action, path, user, resourceOverrides);
    } catch (error) {
      if (error instanceof PolicyDeniedError) {
        res.status(403).json({ error: error.message, plugin: this.name });
        return false;
      }
      throw error;
    }

    return true;
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
        policy: volumeCfg.policy ?? policy.publicRead(),
      };
      this.volumeConfigs[key] = mergedConfig;

      this.volumeConnectors[key] = new FilesConnector({
        defaultVolume: volumePath,
        timeout: config.timeout,
        telemetry: config.telemetry,
        customContentTypes: mergedConfig.customContentTypes,
      });
    }

    // Warn at startup for volumes without an explicit policy
    for (const key of this.volumeKeys) {
      if (!volumes[key].policy) {
        logger.warn(
          'Volume "%s" has no explicit policy — defaulting to publicRead(). ' +
            "Set a policy in files({ volumes: { %s: { policy: ... } } }) to silence this warning.",
          key,
          key,
        );
      }
    }
  }

  /**
   * Creates a VolumeAPI for a specific volume key.
   * All operations execute as the service principal.
   */
  protected createVolumeAPI(volumeKey: string): VolumeAPI {
    const connector = this.volumeConnectors[volumeKey];
    return {
      list: (directoryPath?: string) =>
        connector.list(getWorkspaceClient(), directoryPath),
      read: (filePath: string, options?: { maxSize?: number }) =>
        connector.read(getWorkspaceClient(), filePath, options),
      download: (filePath: string): Promise<DownloadResponse> =>
        connector.download(getWorkspaceClient(), filePath),
      exists: (filePath: string) =>
        connector.exists(getWorkspaceClient(), filePath),
      metadata: (filePath: string) =>
        connector.metadata(getWorkspaceClient(), filePath),
      upload: (
        filePath: string,
        contents: ReadableStream | Buffer | string,
        options?: { overwrite?: boolean },
      ) => connector.upload(getWorkspaceClient(), filePath, contents, options),
      createDirectory: (directoryPath: string) =>
        connector.createDirectory(getWorkspaceClient(), directoryPath),
      delete: (filePath: string) =>
        connector.delete(getWorkspaceClient(), filePath),
      preview: (filePath: string) =>
        connector.preview(getWorkspaceClient(), filePath),
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
    connector: FilesConnector,
  ): void {
    const parent = parentDirectory(parentPath);
    const cachePathSegment = parent
      ? connector.resolvePath(parent)
      : "__root__";
    const listKey = this.cache.generateKey(
      [`files:${volumeKey}:list`, cachePathSegment],
      getCurrentUserId(),
    );
    this.cache.delete(listKey);
  }

  /**
   * Like `execute()`, but re-throws Databricks API client errors (4xx)
   * so route handlers can return the appropriate HTTP status via `_handleApiError`.
   *
   * Server errors and infrastructure failures are still swallowed (returns `undefined`).
   */
  private async _executeOrThrow<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    options: PluginExecutionSettings,
    userKey?: string,
  ): Promise<T | undefined> {
    let capturedClientError: unknown;

    const result = await this.execute<T>(
      async (signal) => {
        try {
          return await fn(signal);
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.statusCode !== undefined &&
            error.statusCode >= 400 &&
            error.statusCode < 500
          ) {
            capturedClientError = error;
          }
          throw error;
        }
      },
      options,
      userKey,
    );

    if (result === undefined && capturedClientError) {
      throw capturedClientError;
    }

    return result;
  }

  private _handleApiError(
    res: express.Response,
    error: unknown,
    fallbackMessage: string,
  ): void {
    if (error instanceof PolicyDeniedError) {
      res.status(403).json({
        error: error.message,
        plugin: this.name,
      });
      return;
    }
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
    if (!(await this._enforcePolicy(req, res, volumeKey, "list"))) return;

    const path = req.query.path as string | undefined;

    try {
      const result = await this.execute(
        async () => connector.list(getWorkspaceClient(), path),
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
    if (!(await this._enforcePolicy(req, res, volumeKey, "read"))) return;

    const path = req.query.path as string;
    const valid = this._isValidPath(path);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }

    try {
      const result = await this.execute(
        async () => connector.read(getWorkspaceClient(), path),
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
    if (!(await this._enforcePolicy(req, res, volumeKey, opts.mode))) return;

    const path = req.query.path as string;
    const valid = this._isValidPath(path);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }

    const label = opts.mode === "download" ? "Download" : "Raw fetch";
    const volumeCfg = this.volumeConfigs[volumeKey];

    try {
      const settings: PluginExecutionSettings = {
        default: FILES_DOWNLOAD_DEFAULTS,
      };
      const response = await this.execute(
        async () => connector.download(getWorkspaceClient(), path),
        settings,
      );

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
    if (!(await this._enforcePolicy(req, res, volumeKey, "exists"))) return;

    const path = req.query.path as string;
    const valid = this._isValidPath(path);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }

    try {
      const result = await this.execute(
        async () => connector.exists(getWorkspaceClient(), path),
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
    if (!(await this._enforcePolicy(req, res, volumeKey, "metadata"))) return;

    const path = req.query.path as string;
    const valid = this._isValidPath(path);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }

    try {
      const result = await this.execute(
        async () => connector.metadata(getWorkspaceClient(), path),
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
    if (!(await this._enforcePolicy(req, res, volumeKey, "preview"))) return;

    const path = req.query.path as string;
    const valid = this._isValidPath(path);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }

    try {
      const result = await this.execute(
        async () => connector.preview(getWorkspaceClient(), path),
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

    if (
      !(await this._enforcePolicy(req, res, volumeKey, "upload", {
        size: contentLength,
      }))
    )
      return;

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
      const settings: PluginExecutionSettings = {
        default: FILES_WRITE_DEFAULTS,
      };
      const result = await this.trackWrite(() =>
        this.execute(async () => {
          await connector.upload(getWorkspaceClient(), path, webStream);
          return { success: true as const };
        }, settings),
      );

      this._invalidateListCache(volumeKey, path, connector);

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
    if (!(await this._enforcePolicy(req, res, volumeKey, "mkdir"))) return;

    const dirPath =
      typeof req.body?.path === "string" ? req.body.path : undefined;
    const valid = this._isValidPath(dirPath);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }

    try {
      const settings: PluginExecutionSettings = {
        default: FILES_WRITE_DEFAULTS,
      };
      const result = await this.trackWrite(() =>
        this.execute(async () => {
          await connector.createDirectory(getWorkspaceClient(), dirPath);
          return { success: true as const };
        }, settings),
      );

      this._invalidateListCache(volumeKey, dirPath, connector);

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
    if (!(await this._enforcePolicy(req, res, volumeKey, "delete"))) return;

    const rawPath = req.query.path as string | undefined;
    const valid = this._isValidPath(rawPath);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }
    const path = rawPath as string;

    try {
      const settings: PluginExecutionSettings = {
        default: FILES_WRITE_DEFAULTS,
      };
      const result = await this.trackWrite(() =>
        this.execute(async () => {
          await connector.delete(getWorkspaceClient(), path);
          return { success: true as const };
        }, settings),
      );

      this._invalidateListCache(volumeKey, path, connector);

      if (result === undefined) {
        res.status(500).json({ error: "Delete failed", plugin: this.name });
        return;
      }

      res.json(result);
    } catch (error) {
      this._handleApiError(res, error, "Delete failed");
    }
  }

  /**
   * Creates a VolumeAPI that enforces the volume's policy and then delegates
   * to the connector as the service principal.
   */
  private _createPolicyWrappedAPI(
    volumeKey: string,
    user: FilePolicyUser,
  ): VolumeAPI {
    const connector = this.volumeConnectors[volumeKey];
    const check = (
      action: FileAction,
      path: string,
      overrides?: Partial<FileResource>,
    ) => this._checkPolicy(volumeKey, action, path, user, overrides);

    return {
      list: async (directoryPath?: string) => {
        await check("list", directoryPath ?? "/");
        return connector.list(getWorkspaceClient(), directoryPath);
      },
      read: async (filePath: string, options?: { maxSize?: number }) => {
        await check("read", filePath);
        return connector.read(getWorkspaceClient(), filePath, options);
      },
      download: async (filePath: string) => {
        await check("download", filePath);
        return connector.download(getWorkspaceClient(), filePath);
      },
      exists: async (filePath: string) => {
        await check("exists", filePath);
        return connector.exists(getWorkspaceClient(), filePath);
      },
      metadata: async (filePath: string) => {
        await check("metadata", filePath);
        return connector.metadata(getWorkspaceClient(), filePath);
      },
      upload: async (
        filePath: string,
        contents: ReadableStream | Buffer | string,
        options?: { overwrite?: boolean },
      ) => {
        await check("upload", filePath);
        return connector.upload(
          getWorkspaceClient(),
          filePath,
          contents,
          options,
        );
      },
      createDirectory: async (directoryPath: string) => {
        await check("mkdir", directoryPath);
        return connector.createDirectory(getWorkspaceClient(), directoryPath);
      },
      delete: async (filePath: string) => {
        await check("delete", filePath);
        return connector.delete(getWorkspaceClient(), filePath);
      },
      preview: async (filePath: string) => {
        await check("preview", filePath);
        return connector.preview(getWorkspaceClient(), filePath);
      },
    };
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
   * All operations execute as the service principal.
   * Use policies to control per-user access.
   *
   * @example
   * ```ts
   * // Service principal access
   * appKit.files("uploads").list()
   *
   * // With policy: pass user identity for access control
   * appKit.files("uploads").asUser(req).list()
   * ```
   */
  exports(): FilesExport {
    const resolveVolume = (volumeKey: string): VolumeHandle => {
      if (!this.volumeKeys.includes(volumeKey)) {
        throw new Error(
          `Unknown volume "${volumeKey}". Available volumes: ${this.volumeKeys.join(", ")}`,
        );
      }

      // Lazy user resolution: getCurrentUserId() is called when a method
      // is invoked (policy check), not when exports() is called.
      const spUser: FilePolicyUser = {
        get id() {
          return getCurrentUserId();
        },
        isServicePrincipal: true,
      };
      const spApi = this._createPolicyWrappedAPI(volumeKey, spUser);

      return {
        ...spApi,
        asUser: (req: import("express").Request) => {
          const user = this._extractUser(req);
          return this._createPolicyWrappedAPI(volumeKey, user);
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
