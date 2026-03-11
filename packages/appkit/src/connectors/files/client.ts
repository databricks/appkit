import { ApiError, type WorkspaceClient } from "@databricks/sdk-experimental";
import type { TelemetryOptions } from "shared";
import { createLogger } from "../../logging/logger";
import type {
  DirectoryEntry,
  DownloadResponse,
  FileMetadata,
  FilePreview,
  PresignedDownloadUrl,
} from "../../plugins/files/types";
import type { TelemetryProvider } from "../../telemetry";
import {
  type Counter,
  type Histogram,
  type Span,
  SpanKind,
  SpanStatusCode,
  TelemetryManager,
} from "../../telemetry";
import {
  contentTypeFromPath,
  FILES_MAX_READ_SIZE,
  isTextContentType,
} from "./defaults";

const logger = createLogger("connectors:files");

export interface FilesConnectorConfig {
  defaultVolume?: string;
  timeout?: number;
  telemetry?: TelemetryOptions;
  customContentTypes?: Record<string, string>;
}

export class FilesConnector {
  private readonly name = "files";
  private defaultVolume: string | undefined;
  private readonly customContentTypes: Record<string, string> | undefined;

  private readonly telemetry: TelemetryProvider;
  private readonly telemetryMetrics: {
    operationCount: Counter;
    operationDuration: Histogram;
  };

  constructor(config: FilesConnectorConfig) {
    this.defaultVolume = config.defaultVolume;
    this.customContentTypes = config.customContentTypes;

    this.telemetry = TelemetryManager.getProvider(this.name, config.telemetry);
    this.telemetryMetrics = {
      operationCount: this.telemetry
        .getMeter()
        .createCounter("files.operation.count", {
          description: "Total number of file operations",
          unit: "1",
        }),
      operationDuration: this.telemetry
        .getMeter()
        .createHistogram("files.operation.duration", {
          description: "Duration of file operations",
          unit: "ms",
        }),
    };
  }

  resolvePath(filePath: string): string {
    if (filePath.length > 4096) {
      throw new Error(
        `Path exceeds maximum length of 4096 characters (got ${filePath.length}).`,
      );
    }
    if (filePath.includes("\0")) {
      throw new Error("Path must not contain null bytes.");
    }

    const segments = filePath.split("/");
    if (segments.some((s) => s === "..")) {
      throw new Error('Path traversal ("../") is not allowed.');
    }
    if (filePath.startsWith("/")) {
      if (!filePath.startsWith("/Volumes/")) {
        throw new Error(
          'Absolute paths must start with "/Volumes/". ' +
            "Unity Catalog volume paths follow the format: /Volumes/<catalog>/<schema>/<volume>/",
        );
      }
      return filePath;
    }
    if (!this.defaultVolume) {
      throw new Error(
        "Cannot resolve relative path: no default volume set. Use an absolute path or set a default volume.",
      );
    }
    return `${this.defaultVolume}/${filePath}`;
  }

  private async traced<T>(
    operation: string,
    attributes: Record<string, string>,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    const startTime = Date.now();
    let success = false;

    return this.telemetry.startActiveSpan(
      `files.${operation}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "files.operation": operation,
          ...attributes,
        },
      },
      async (span: Span) => {
        try {
          const result = await fn(span);
          success = true;
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          span.end();
          const duration = Date.now() - startTime;
          const metricAttrs = {
            "files.operation": operation,
            success: String(success),
          };
          this.telemetryMetrics.operationCount.add(1, metricAttrs);
          this.telemetryMetrics.operationDuration.record(duration, metricAttrs);
        }
      },
      { name: this.name, includePrefix: true },
    );
  }

  async list(
    client: WorkspaceClient,
    directoryPath?: string,
  ): Promise<DirectoryEntry[]> {
    const resolvedPath = directoryPath
      ? this.resolvePath(directoryPath)
      : this.defaultVolume;
    if (!resolvedPath) {
      throw new Error("No directory path provided and no default volume set.");
    }

    return this.traced("list", { "files.path": resolvedPath }, async () => {
      const entries: DirectoryEntry[] = [];
      for await (const entry of client.files.listDirectoryContents({
        directory_path: resolvedPath,
      })) {
        entries.push(entry);
      }
      return entries;
    });
  }

  async read(
    client: WorkspaceClient,
    filePath: string,
    options?: { maxSize?: number },
  ): Promise<string> {
    const resolvedPath = this.resolvePath(filePath);
    const maxSize = options?.maxSize ?? FILES_MAX_READ_SIZE;
    return this.traced("read", { "files.path": resolvedPath }, async () => {
      const response = await this.download(client, filePath);
      if (!response.contents) {
        return "";
      }
      const reader = response.contents.getReader();
      const decoder = new TextDecoder();
      let result = "";
      let bytesRead = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > maxSize) {
          await reader.cancel();
          throw new Error(
            `File exceeds maximum read size (${maxSize} bytes). Use download() for large files.`,
          );
        }
        result += decoder.decode(value, { stream: true });
      }
      result += decoder.decode();
      return result;
    });
  }

  async download(
    client: WorkspaceClient,
    filePath: string,
  ): Promise<DownloadResponse> {
    const resolvedPath = this.resolvePath(filePath);
    return this.traced("download", { "files.path": resolvedPath }, async () => {
      return client.files.download({
        file_path: resolvedPath,
      });
    });
  }

  /**
   * Requests a pre-signed download URL from Unity Catalog.
   * The returned URL points directly to cloud storage (S3/ADLS/GCS),
   * bypassing the Databricks Apps proxy.
   *
   * Uses the same direct-fetch pattern as {@link upload} to call the
   * undocumented `/api/2.0/fs/create-download-url` endpoint used by
   * the Databricks Python SDK.
   *
   * Known error modes (mirroring the Python SDK):
   * - 403 with `FILES_API_API_IS_NOT_ENABLED` → feature not enabled on workspace
   * - 500 with `FILES_API_REQUESTER_NETWORK_ZONE_UNKNOWN` → network zone issue
   * - 404 → endpoint not available (older workspace version)
   * - Other errors → transient or auth failures
   */
  async createDownloadUrl(
    client: WorkspaceClient,
    filePath: string,
    options?: { expireInSeconds?: number },
  ): Promise<PresignedDownloadUrl> {
    const resolvedPath = this.resolvePath(filePath);
    const expireInSeconds = options?.expireInSeconds ?? 900;

    if (expireInSeconds < 1 || expireInSeconds > 3600) {
      throw new Error(
        `expireInSeconds must be between 1 and 3600 (got ${expireInSeconds}).`,
      );
    }

    return this.traced(
      "createDownloadUrl",
      {
        "files.path": resolvedPath,
        "files.presign.expire_seconds": String(expireInSeconds),
      },
      async (span) => {
        const hostValue = client.config.host;
        if (!hostValue) {
          throw new Error(
            "Databricks host is not configured. Set DATABRICKS_HOST or configure client.config.host.",
          );
        }
        const host = hostValue.startsWith("http")
          ? hostValue
          : `https://${hostValue}`;

        const requestExpireTime = new Date(
          Date.now() + expireInSeconds * 1000,
        ).toISOString();

        const url = new URL("/api/2.0/fs/create-download-url", host);
        url.searchParams.set("path", resolvedPath);
        url.searchParams.set("expire_time", requestExpireTime);

        const headers = new Headers({
          "Content-Type": "application/json",
        });
        await client.config.authenticate(headers);

        const res = await fetch(url.toString(), {
          method: "POST",
          headers,
        });

        if (!res.ok) {
          const text = await res.text();
          const errorCode = parsePresignErrorCode(res.status, text);

          span.setAttribute("files.presign.error_code", errorCode);
          span.setAttribute("files.presign.status_code", res.status);

          logger.error(
            `create-download-url failed (${res.status}, code=${errorCode}): ${text}`,
          );

          const safeMessage =
            text.length > 200 ? `${text.slice(0, 200)}…` : text;
          throw new ApiError(
            `Failed to create download URL: ${safeMessage}`,
            errorCode,
            res.status,
            undefined,
            [],
          );
        }

        const body = (await res.json()) as {
          url: string;
          headers?: Array<{ name: string; value: string }>;
        };

        // Compute expiresAt after the successful response to reduce clock drift
        const actualExpiresAt = new Date(
          Date.now() + expireInSeconds * 1000,
        ).toISOString();

        const responseHeaders: Record<string, string> = {};
        if (body.headers) {
          for (const h of body.headers) {
            responseHeaders[h.name] = h.value;
          }
        }

        return {
          url: body.url,
          headers: responseHeaders,
          expiresAt: actualExpiresAt,
        };
      },
    );
  }

  async exists(client: WorkspaceClient, filePath: string): Promise<boolean> {
    const resolvedPath = this.resolvePath(filePath);
    return this.traced("exists", { "files.path": resolvedPath }, async () => {
      try {
        await this.metadata(client, filePath);
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 404) {
          return false;
        }
        throw error;
      }
    });
  }

  async metadata(
    client: WorkspaceClient,
    filePath: string,
  ): Promise<FileMetadata> {
    const resolvedPath = this.resolvePath(filePath);
    return this.traced("metadata", { "files.path": resolvedPath }, async () => {
      const response = await client.files.getMetadata({
        file_path: resolvedPath,
      });
      return {
        contentLength: response["content-length"],
        contentType: contentTypeFromPath(
          filePath,
          response["content-type"],
          this.customContentTypes,
        ),
        lastModified: response["last-modified"],
      };
    });
  }

  async upload(
    client: WorkspaceClient,
    filePath: string,
    contents: ReadableStream | Buffer | string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    const resolvedPath = this.resolvePath(filePath);

    return this.traced("upload", { "files.path": resolvedPath }, async () => {
      const body = contents;
      const overwrite = options?.overwrite ?? true;

      // Workaround: The SDK's files.upload() has two bugs:
      // 1. It ignores the `contents` field (sets body to undefined)
      // 2. apiClient.request() checks `instanceof` against its own ReadableStream
      //    subclass, so standard ReadableStream instances get JSON.stringified to "{}"
      // Bypass both by calling the REST API directly with SDK-provided auth.
      const hostValue = client.config.host;
      if (!hostValue) {
        throw new Error(
          "Databricks host is not configured. Set DATABRICKS_HOST or configure client.config.host.",
        );
      }
      const host = hostValue.startsWith("http")
        ? hostValue
        : `https://${hostValue}`;
      const url = new URL(`/api/2.0/fs/files${resolvedPath}`, host);
      url.searchParams.set("overwrite", String(overwrite));

      const headers = new Headers({
        "Content-Type": "application/octet-stream",
      });
      const fetchOptions: RequestInit = { method: "PUT", headers, body };

      if (body instanceof ReadableStream) {
        fetchOptions.duplex = "half";
      } else if (body instanceof Buffer) {
        headers.set("Content-Length", String(body.length));
      } else if (typeof body === "string") {
        headers.set("Content-Length", String(Buffer.byteLength(body)));
      }

      await client.config.authenticate(headers);

      const res = await fetch(url.toString(), fetchOptions);

      if (!res.ok) {
        const text = await res.text();
        logger.error(`Upload failed (${res.status}): ${text}`);
        const safeMessage = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        throw new ApiError(
          `Upload failed: ${safeMessage}`,
          "UPLOAD_FAILED",
          res.status,
          undefined,
          [],
        );
      }
    });
  }

  async createDirectory(
    client: WorkspaceClient,
    directoryPath: string,
  ): Promise<void> {
    const resolvedPath = this.resolvePath(directoryPath);
    return this.traced(
      "createDirectory",
      { "files.path": resolvedPath },
      async () => {
        await client.files.createDirectory({
          directory_path: resolvedPath,
        });
      },
    );
  }

  async delete(client: WorkspaceClient, filePath: string): Promise<void> {
    const resolvedPath = this.resolvePath(filePath);
    return this.traced("delete", { "files.path": resolvedPath }, async () => {
      await client.files.delete({
        file_path: resolvedPath,
      });
    });
  }

  async preview(
    client: WorkspaceClient,
    filePath: string,
    options?: { maxChars?: number },
  ): Promise<FilePreview> {
    const resolvedPath = this.resolvePath(filePath);
    return this.traced("preview", { "files.path": resolvedPath }, async () => {
      const meta = await this.metadata(client, filePath);
      const isText = isTextContentType(meta.contentType);
      const isImage = meta.contentType?.startsWith("image/") || false;

      if (!isText) {
        return { ...meta, textPreview: null, isText: false, isImage };
      }

      const response = await client.files.download({
        file_path: resolvedPath,
      });
      if (!response.contents) {
        return { ...meta, textPreview: "", isText: true, isImage: false };
      }

      const reader = response.contents.getReader();
      const decoder = new TextDecoder();
      let preview = "";
      const maxChars = options?.maxChars ?? 1024;

      while (preview.length < maxChars) {
        const { done, value } = await reader.read();
        if (done) break;
        preview += decoder.decode(value, { stream: true });
      }
      preview += decoder.decode();
      await reader.cancel();

      if (preview.length > maxChars) {
        preview = preview.slice(0, maxChars);
      }

      return { ...meta, textPreview: preview, isText: true, isImage: false };
    });
  }
}

/**
 * Well-known error codes from the `create-download-url` endpoint.
 * These mirror the error reasons the Databricks Python SDK checks for.
 */
export const PRESIGN_ERROR_CODES = {
  /** Pre-signed URL feature is not enabled on this workspace. */
  NOT_ENABLED: "PRESIGNED_URL_NOT_ENABLED",
  /** The requester's network zone is unknown — typically a private link or firewall issue. */
  NETWORK_ZONE_UNKNOWN: "PRESIGNED_URL_NETWORK_ZONE_UNKNOWN",
  /** The endpoint itself is not available (404) — workspace may be on an older version. */
  NOT_AVAILABLE: "PRESIGNED_URL_NOT_AVAILABLE",
  /** Generic failure for unrecognised error shapes. */
  FAILED: "PRESIGNED_URL_FAILED",
} as const;

/**
 * Parses the Databricks API error response from `create-download-url` and
 * returns a well-known error code.
 *
 * The Python SDK checks for two specific `error_info` reasons:
 * - `FILES_API_API_IS_NOT_ENABLED` (PermissionDenied / 403)
 * - `FILES_API_REQUESTER_NETWORK_ZONE_UNKNOWN` (InternalError / 500)
 */
function parsePresignErrorCode(status: number, responseText: string): string {
  if (status === 404) {
    return PRESIGN_ERROR_CODES.NOT_AVAILABLE;
  }

  try {
    const body = JSON.parse(responseText) as {
      error_code?: string;
      message?: string;
      error_info?: Array<{ reason?: string }>;
    };

    // Check error_info array (same structure the Python SDK inspects)
    if (body.error_info) {
      for (const info of body.error_info) {
        if (info.reason === "FILES_API_API_IS_NOT_ENABLED") {
          return PRESIGN_ERROR_CODES.NOT_ENABLED;
        }
        if (info.reason === "FILES_API_REQUESTER_NETWORK_ZONE_UNKNOWN") {
          return PRESIGN_ERROR_CODES.NETWORK_ZONE_UNKNOWN;
        }
      }
    }

    // Fallback: check error_code field
    if (body.error_code === "PERMISSION_DENIED" && status === 403) {
      return PRESIGN_ERROR_CODES.NOT_ENABLED;
    }
  } catch {
    // Response wasn't JSON — use generic code
  }

  return PRESIGN_ERROR_CODES.FAILED;
}
