import { ApiError, type WorkspaceClient } from "@databricks/sdk-experimental";
import type { TelemetryOptions } from "shared";
import { createLogger } from "../../logging/logger";
import type {
  DirectoryEntry,
  DownloadResponse,
  FileMetadata,
  FilePreview,
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
