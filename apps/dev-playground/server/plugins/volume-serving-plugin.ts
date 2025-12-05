import { join, normalize } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type { IAppRouter, IAppRequest } from "shared";
import {
  type BasePluginConfig,
  Plugin,
  toPlugin,
  getRequestContext,
  type Response,
} from "@databricks/app-kit";

// Type definitions for volume serving
export type Action = "download" | "list" | "upload" | "upsert";

export interface Resource {
  path: string;
  volume: string;
  isDirectory: boolean;
  size: number;
  mimeType: string;
}

export type User = {
  id: string;
};

export type Policy = (action: Action, resource: Resource, user: User) => boolean;

// Policy combinators
export const policy = {
  /**
   * Combines multiple policies with AND logic - all policies must return true
   */
  all: (...policies: Policy[]): Policy => {
    return (action: Action, resource: Resource, user: User): boolean => {
      for (const p of policies) {
        if (!p(action, resource, user)) {
          return false;
        }
      }
      return true;
    };
  },

  /**
   * Combines multiple policies with OR logic - at least one policy must return true
   */
  any: (...policies: Policy[]): Policy => {
    return (action: Action, resource: Resource, user: User): boolean => {
      for (const p of policies) {
        if (p(action, resource, user)) {
          return true;
        }
      }
      return false;
    };
  },

  /**
   * Allow downloading files but deny listing directories.
   * Useful for serving public files where you don't want directory browsing.
   */
  publicRead: (): Policy => {
    return (action: Action, resource: Resource, user: User): boolean => {
      return action === "download";
    };
  },

  /**
   * Allow downloading files and listing directories (read-only access).
   * Useful for public file browsing where users can explore and download.
   */
  publicReadAndList: (): Policy => {
    return (action: Action, resource: Resource, user: User): boolean => {
      return action === "download" || action === "list";
    };
  },
};

export interface VolumeConfig {
  volumePath: string;
  pathPrefix?: string;
  policy: Policy;
  onAfterUpload?: (
    req: IAppRequest,
    res: Response,
    resource: Resource,
    user: User,
  ) => void;
}

export interface VolumeConfigs {
  [key: string]: VolumeConfig;
}

export interface VolumeServingConfig extends BasePluginConfig {
  volumeConfigs: VolumeConfigs;
}

export class VolumeServingPlugin extends Plugin {
  static DEFAULT_CONFIG: Record<string, unknown> = {};
  name = "volume-serving";
  envVars = [];
  protected declare config: VolumeServingConfig;

  constructor(config: VolumeServingConfig) {
    super(config);
    this.config = config;
  }

  async setup(): Promise<void> {
    console.log("[VolumeServing] Plugin initialized");

    const configKeys = Object.keys(this.config.volumeConfigs);
    if (configKeys.length === 0) {
      console.warn("[VolumeServing] No volume configurations provided");
      return;
    }

    console.log(`[VolumeServing] Configured ${configKeys.length} volume(s):`);
    for (const [key, config] of Object.entries(this.config.volumeConfigs)) {
      const prefixInfo = config.pathPrefix
        ? ` (prefix: ${config.pathPrefix})`
        : "";
      console.log(`  - ${key}: ${config.volumePath}${prefixInfo}`);
    }
  }

  private parsePath(requestPath: string, configKey: string): string {
    const prefix = `/api/${this.name}/${configKey}`;
    const path = requestPath.startsWith(prefix)
      ? requestPath.substring(prefix.length)
      : requestPath;
    return path.startsWith("/") ? path : `/${path}`;
  }

  private normalizePath(
    requestPath: string,
    volumePath: string,
    pathPrefix?: string,
  ): string | null {
    if (!volumePath) {
      throw new Error("Volume path is not configured");
    }

    // Remove leading slash for path.join to work correctly
    const cleanPath = requestPath.startsWith("/")
      ? requestPath.slice(1)
      : requestPath;

    // Normalize to resolve .. and . segments
    const normalized = normalize(cleanPath);

    // Check for path traversal attempts
    // After normalization, the path should not start with .. or contain ..
    if (normalized.startsWith("..") || normalized.includes("/..")) {
      console.warn(
        `[VolumeServing] Path traversal attempt blocked: ${requestPath}`,
      );
      return null;
    }

    // Prepend pathPrefix if configured (internal prefix not visible in public URLs)
    const pathWithPrefix = pathPrefix
      ? join(pathPrefix, normalized)
      : normalized;

    // Construct full path
    const fullPath = join(volumePath, pathWithPrefix);

    // Final security check: ensure the path starts with the volume path
    // If pathPrefix is set, also ensure path is under the prefix
    const expectedBasePath = pathPrefix
      ? join(volumePath, pathPrefix)
      : volumePath;

    if (!fullPath.startsWith(expectedBasePath)) {
      console.warn(
        `[VolumeServing] Path outside allowed area blocked: ${requestPath}`,
      );
      return null;
    }

    return fullPath;
  }

  private async validatePolicy(
    action: Action,
    resource: Resource,
    user: User,
    policy: Policy,
  ): Promise<boolean> {
    try {
      return policy(action, resource, user);
    } catch (error) {
      console.error("[VolumeServing] Policy execution error:", error);
      return false;
    }
  }

  private async handleGetRequest(
    req: IAppRequest,
    res: Response,
    configKey: string,
    volumeConfig: VolumeConfig,
  ): Promise<void> {
    try {
      const requestContext = getRequestContext();
      const serviceClient: WorkspaceClient =
        requestContext.serviceDatabricksClient;
      const user: User = { id: requestContext.userId };

      const filePath = this.parsePath(req.path, configKey);
      const fullPath = this.normalizePath(
        filePath,
        volumeConfig.volumePath,
        volumeConfig.pathPrefix,
      );

      if (!fullPath) {
        res.status(403).json({
          error: "Invalid path",
          message: "Path traversal attempts are not allowed",
        });
        return;
      }

      // Determine action based on path
      const action: Action = filePath.endsWith("/") ? "list" : "download";

      if (action === "list") {
        // Directory listing
        const resource: Resource = {
          path: filePath,
          volume: configKey,
          isDirectory: true,
          size: 0,
          mimeType: "",
        };

        if (
          !(await this.validatePolicy(
            action,
            resource,
            user,
            volumeConfig.policy,
          ))
        ) {
          res.status(403).json({
            error: "Forbidden",
            message: "You do not have permission to list this directory",
          });
          return;
        }

        // Stream directory listing
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Transfer-Encoding", "chunked");

        try {
          for await (const item of this.listDirectoryStream(
            fullPath,
            filePath,
          )) {
            res.write(`${JSON.stringify(item)}\n`);
          }
          res.end();
        } catch (streamError) {
          console.error(
            "[VolumeServing] Error streaming directory:",
            streamError,
          );
          if (!res.headersSent) {
            res.status(500).json({ error: "Failed to list directory" });
          }
        }
      } else {
        // File download
        try {
          const downloadResponse = await serviceClient.files.download({
            file_path: fullPath,
          });

          const resource: Resource = {
            path: filePath,
            volume: configKey,
            isDirectory: false,
            size: Number(downloadResponse["content-length"]) || 0,
            mimeType: this.getContentType(filePath),
          };

          if (
            !(await this.validatePolicy(
              action,
              resource,
              user,
              volumeConfig.policy,
            ))
          ) {
            res.status(403).json({
              error: "Forbidden",
              message: "You do not have permission to download this file",
            });
            return;
          }

          // Stream the file
          await this.streamFile(fullPath, filePath, res);
        } catch (error: any) {
          if (
            error.message?.includes("NOT_FOUND") ||
            error.statusCode === 404
          ) {
            res.status(404).json({ error: "File not found" });
          } else {
            throw error;
          }
        }
      }
    } catch (error) {
      console.error("[VolumeServing] Error handling GET request:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  }

  private async handlePostRequest(
    req: IAppRequest,
    res: Response,
    configKey: string,
    volumeConfig: VolumeConfig,
  ): Promise<void> {
    try {
      const requestContext = getRequestContext();
      const serviceClient: WorkspaceClient =
        requestContext.serviceDatabricksClient;
      const user: User = { id: requestContext.userId };

      const filePath = this.parsePath(req.path, configKey);
      const fullPath = this.normalizePath(
        filePath,
        volumeConfig.volumePath,
        volumeConfig.pathPrefix,
      );

      if (!fullPath) {
        res.status(403).json({
          error: "Invalid path",
          message: "Path traversal attempts are not allowed",
        });
        return;
      }

      // Don't allow upload to directories
      if (filePath.endsWith("/")) {
        res.status(400).json({
          error: "Bad request",
          message: "Cannot upload to a directory path. Specify a file name.",
        });
        return;
      }

      // Build resource for policy validation
      const contentLength = req.headers["content-length"]
        ? Number.parseInt(req.headers["content-length"])
        : 0;
      const contentType =
        (req.headers["content-type"] as string) || "application/octet-stream";

      const resource: Resource = {
        path: filePath,
        volume: configKey,
        isDirectory: false,
        size: contentLength,
        mimeType: contentType,
      };

      // Validate upload/upsert policies (both mean the same thing)
      const canUpload =
        (await this.validatePolicy(
          "upload",
          resource,
          user,
          volumeConfig.policy,
        )) ||
        (await this.validatePolicy(
          "upsert",
          resource,
          user,
          volumeConfig.policy,
        ));

      if (!canUpload) {
        res.status(403).json({
          error: "Forbidden",
          message: "You do not have permission to upload to this path",
        });
        return;
      }

      // File size limit check (100MB)
      const MAX_FILE_SIZE = 100 * 1024 * 1024;
      if (contentLength > MAX_FILE_SIZE) {
        res.status(413).json({
          error: "Payload too large",
          message: `File size exceeds maximum allowed size of ${MAX_FILE_SIZE} bytes`,
        });
        return;
      }

      // Collect request body
      const chunks: Buffer[] = [];

      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on("end", async () => {
        try {
          const fileBuffer = Buffer.concat(chunks);

          // Convert Buffer to ReadableStream for SDK upload
          const nodeStream = Readable.from(fileBuffer);
          const webStream = Readable.toWeb(nodeStream);

          // Upload file to Databricks volume
          await serviceClient.files.upload({
            file_path: fullPath,
            contents: webStream as any, // Type cast due to ReadableStream version differences
            overwrite: true,
          });

          // Call onAfterUpload callback if defined
          if (volumeConfig.onAfterUpload) {
            try {
              await volumeConfig.onAfterUpload(req, res, resource, user);
            } catch (callbackError) {
              console.error(
                "[VolumeServing] onAfterUpload callback error:",
                callbackError,
              );
              // If callback fails and response not sent, send error
              if (!res.headersSent) {
                res.status(500).json({
                  error: "Callback failed",
                  message: "File uploaded but callback failed",
                });
              }
            }
          } else {
            // Send default success response if no callback
            res.status(200).json({
              success: true,
              message: "File uploaded successfully",
              path: filePath,
              size: fileBuffer.length,
            });
          }
        } catch (uploadError: any) {
          console.error("[VolumeServing] Error uploading file:", uploadError);
          if (!res.headersSent) {
            res.status(500).json({
              error: "Upload failed",
              message:
                uploadError.message || "Failed to upload file to volume",
            });
          }
        }
      });

      req.on("error", (error) => {
        console.error("[VolumeServing] Error reading request body:", error);
        if (!res.headersSent) {
          res.status(500).json({
            error: "Upload failed",
            message: "Failed to read request body",
          });
        }
      });
    } catch (error) {
      console.error("[VolumeServing] Error handling POST request:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  }

  injectRoutes(router: IAppRouter): void {
    // Register routes for each volume config
    for (const [configKey, volumeConfig] of Object.entries(
      this.config.volumeConfigs,
    )) {
      // GET route for download and list operations
      router.get(`/${configKey}/*`, async (req, res) => {
        await this.handleGetRequest(req, res, configKey, volumeConfig);
      });

      // POST route for upload operations
      router.post(`/${configKey}/*`, async (req, res) => {
        await this.handlePostRequest(req, res, configKey, volumeConfig);
      });
    }
  }

  private async streamFile(
    fullPath: string,
    displayPath: string,
    res: Response,
  ): Promise<void> {
    const requestContext = getRequestContext();
    const serviceClient: WorkspaceClient =
      requestContext.serviceDatabricksClient;

    try {
      const downloadResponse = await serviceClient.files.download({
        file_path: fullPath,
      });

      const webStream = downloadResponse.contents;
      if (!webStream) {
        res.status(404).json({ error: "File not found or cannot be read" });
        return;
      }

      const nodeStream = Readable.fromWeb(webStream as any);
      // const contentType = downloadResponse["content-type"] || this.getContentType(displayPath);
      const contentType = this.getContentType(displayPath);

      res.setHeader("Content-Type", contentType);
      if (downloadResponse["content-length"]) {
        res.setHeader(
          "Content-Length",
          downloadResponse["content-length"].toString(),
        );
      }
      res.setHeader("Cache-Control", "public, max-age=3600");
      if (downloadResponse["last-modified"]) {
        res.setHeader("Last-Modified", downloadResponse["last-modified"]);
        const etag = `"${Buffer.from(downloadResponse["last-modified"]).toString("base64")}"`;
        res.setHeader("ETag", etag);
      }
      res.setHeader("Accept-Ranges", "bytes");

      await pipeline(nodeStream, res);
    } catch (error: any) {
      console.error("[VolumeServing] Error downloading file:", error);
      if (!res.headersSent) {
        if (error.message?.includes("NOT_FOUND") || error.statusCode === 404) {
          res.status(404).json({ error: "File not found" });
        } else {
          res.status(500).json({ error: "Failed to download file" });
        }
      }
    }
  }

  private getContentType(filePath: string): string {
    const ext = filePath.split(".").pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      // Text
      txt: "text/plain",
      html: "text/html",
      css: "text/css",
      js: "application/javascript",
      json: "application/json",
      xml: "application/xml",
      csv: "text/csv",

      // Images
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      svg: "image/svg+xml",
      webp: "image/webp",
      ico: "image/x-icon",

      // Documents
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",

      // Archives
      zip: "application/zip",
      tar: "application/x-tar",
      gz: "application/gzip",

      // Media
      mp4: "video/mp4",
      mp3: "audio/mpeg",
      wav: "audio/wav",

      // Python/Data Science
      py: "text/x-python",
      ipynb: "application/x-ipynb+json",
      pkl: "application/octet-stream",
      h5: "application/octet-stream",
      parquet: "application/octet-stream",
    };

    return mimeTypes[ext || ""] || "application/octet-stream";
  }

  private async *listDirectoryStream(
    fullPath: string,
    displayPath: string,
  ): AsyncGenerator<any, void, unknown> {
    const requestContext = getRequestContext();
    const serviceClient: WorkspaceClient =
      requestContext.serviceDatabricksClient;

    yield {
      type: "metadata",
      path: displayPath,
      volumePath: this.config.volumePath,
    };

    const iterator = serviceClient.files.listDirectoryContents({
      directory_path: fullPath,
    });

    for await (const item of iterator) {
      const itemPath = `${displayPath}${item.name}${item.is_directory ? "/" : ""}`;
      const mimeType = item.is_directory
        ? null
        : this.getContentType(item.name || "");

      yield {
        type: "file",
        name: item.name || "",
        path: itemPath,
        isDirectory: item.is_directory || false,
        size: item.file_size,
        mimeType,
      };
    }
  }
}

export const volumeServing = toPlugin<
  typeof VolumeServingPlugin,
  VolumeServingConfig,
  "volumeServing"
>(VolumeServingPlugin, "volumeServing");
