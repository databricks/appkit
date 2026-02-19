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
import { contentTypeFromPath } from "./defaults";

const logger = createLogger("connectors:files");

export interface FilesConnectorConfig {
  defaultVolume?: string;
  timeout?: number;
  telemetry?: TelemetryOptions;
}

export class FilesConnector {
  private readonly name = "files";
  private defaultVolume: string | undefined;

  private readonly telemetry: TelemetryProvider;
  private readonly telemetryMetrics: {
    operationCount: Counter;
    operationDuration: Histogram;
  };

  constructor(config: FilesConnectorConfig) {
    this.defaultVolume = config.defaultVolume;

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

  private resolvePath(filePath: string): string {
    if (filePath.startsWith("/")) {
      return filePath;
    }
    if (!this.defaultVolume) {
      throw new Error(
        "Cannot resolve relative path: no default volume set. Use an absolute path or set a default volume.",
      );
    }
    return `${this.defaultVolume}/${filePath}`;
  }

  volume(volumePath: string): FilesConnector {
    return new FilesConnector({
      defaultVolume: volumePath,
      telemetry: false,
    });
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

  async read(client: WorkspaceClient, filePath: string): Promise<string> {
    return this.traced(
      "read",
      { "files.path": this.resolvePath(filePath) },
      async () => {
        const response = await this.download(client, filePath);
        if (!response.contents) {
          return "";
        }
        const reader = response.contents.getReader();
        const decoder = new TextDecoder();
        let result = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          result += decoder.decode(value, { stream: true });
        }
        result += decoder.decode();
        return result;
      },
    );
  }

  async download(
    client: WorkspaceClient,
    filePath: string,
  ): Promise<DownloadResponse> {
    return this.traced(
      "download",
      { "files.path": this.resolvePath(filePath) },
      async () => {
        return client.files.download({
          file_path: this.resolvePath(filePath),
        });
      },
    );
  }

  async exists(client: WorkspaceClient, filePath: string): Promise<boolean> {
    return this.traced(
      "exists",
      { "files.path": this.resolvePath(filePath) },
      async () => {
        try {
          await this.metadata(client, filePath);
          return true;
        } catch (error) {
          if (error instanceof ApiError && error.statusCode === 404) {
            return false;
          }
          throw error;
        }
      },
    );
  }

  async metadata(
    client: WorkspaceClient,
    filePath: string,
  ): Promise<FileMetadata> {
    return this.traced(
      "metadata",
      { "files.path": this.resolvePath(filePath) },
      async () => {
        const response = await client.files.getMetadata({
          file_path: this.resolvePath(filePath),
        });
        return {
          contentLength: response["content-length"],
          contentType: contentTypeFromPath(filePath, response["content-type"]),
          lastModified: response["last-modified"],
        };
      },
    );
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
      const url = new URL(
        `/api/2.0/fs/files${resolvedPath}`,
        client.config.host,
      );
      url.searchParams.set("overwrite", String(overwrite));

      const headers = new Headers({
        "Content-Type": "application/octet-stream",
      });
      const fetchOptions: RequestInit = { method: "PUT", headers, body };

      if (body instanceof ReadableStream) {
        fetchOptions.duplex = "half";
      }

      await client.config.authenticate(headers);

      const res = await fetch(url.toString(), fetchOptions);

      if (!res.ok) {
        const text = await res.text();
        logger.error(`Upload failed (${res.status}): ${text}`);
        throw new Error(`Upload failed (${res.status}): ${text}`);
      }
    });
  }

  async createDirectory(
    client: WorkspaceClient,
    directoryPath: string,
  ): Promise<void> {
    return this.traced(
      "createDirectory",
      { "files.path": this.resolvePath(directoryPath) },
      async () => {
        await client.files.createDirectory({
          directory_path: this.resolvePath(directoryPath),
        });
      },
    );
  }

  async delete(client: WorkspaceClient, filePath: string): Promise<void> {
    return this.traced(
      "delete",
      { "files.path": this.resolvePath(filePath) },
      async () => {
        await client.files.delete({
          file_path: this.resolvePath(filePath),
        });
      },
    );
  }

  async preview(
    client: WorkspaceClient,
    filePath: string,
    options?: { maxBytes?: number },
  ): Promise<FilePreview> {
    return this.traced(
      "preview",
      { "files.path": this.resolvePath(filePath) },
      async () => {
        const meta = await this.metadata(client, filePath);
        const isText =
          meta.contentType?.startsWith("text/") ||
          meta.contentType === "application/json" ||
          meta.contentType === "application/xml" ||
          false;
        const isImage = meta.contentType?.startsWith("image/") || false;

        if (!isText) {
          return { ...meta, textPreview: null, isText: false, isImage };
        }

        const response = await client.files.download({
          file_path: this.resolvePath(filePath),
        });
        if (!response.contents) {
          return { ...meta, textPreview: "", isText: true, isImage: false };
        }

        const reader = response.contents.getReader();
        const decoder = new TextDecoder();
        let preview = "";
        const maxBytes = options?.maxBytes ?? 1024;

        while (preview.length < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          preview += decoder.decode(value, { stream: true });
        }
        preview += decoder.decode();
        await reader.cancel();

        if (preview.length > maxBytes) {
          preview = preview.slice(0, maxBytes);
        }

        return { ...meta, textPreview: preview, isText: true, isImage: false };
      },
    );
  }
}
