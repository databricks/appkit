import { join, normalize } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type { IAppRouter } from "shared";
import {
  type BasePluginConfig,
  Plugin,
  toPlugin,
  getRequestContext,
  type Response,
} from "@databricks/app-kit";

export interface VolumeServingConfig extends BasePluginConfig {
  volumePath?: string;
  enableDirectoryListing?: boolean;
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
    console.log(
      `[VolumeServing] Volume path: ${this.config.volumePath || "not configured"}`,
    );
    console.log(
      `[VolumeServing] Directory listing: ${this.config.enableDirectoryListing ? "enabled" : "disabled"}`,
    );
  }

  private normalizePath(requestPath: string): string | null {
    if (!this.config.volumePath) {
      throw new Error("VOLUME_PATH is not configured");
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

    // Construct full path
    const fullPath = join(this.config.volumePath, normalized);

    // Final security check: ensure the path starts with the volume path
    if (!fullPath.startsWith(this.config.volumePath)) {
      console.warn(
        `[VolumeServing] Path outside volume blocked: ${requestPath}`,
      );
      return null;
    }

    return fullPath;
  }

  injectRoutes(router: IAppRouter): void {
    router.get("/*", async (req, res) => {
      try {
        const requestPath = req.path;
        const pluginPrefix = `/api/${this.name}`;
        let filePath = requestPath.startsWith(pluginPrefix)
          ? requestPath.substring(pluginPrefix.length)
          : requestPath;

        if (!filePath.startsWith("/")) {
          filePath = `/${filePath}`;
        }

        const fullPath = this.normalizePath(filePath);
        if (!fullPath) {
          res.status(403).json({
            error: "Invalid path",
            message: "Path traversal attempts are not allowed",
          });
          return;
        }

        if (filePath.endsWith("/")) {
          if (!this.config.enableDirectoryListing) {
            res.status(403).json({
              error: "Directory listing is disabled",
              message:
                "Set enableDirectoryListing: true in plugin config to enable directory browsing",
            });
            return;
          }

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
          await this.streamFile(fullPath, filePath, res);
        }
      } catch (error) {
        console.error("[VolumeServing] Error handling request:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Internal server error" });
        }
      }
    });
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
