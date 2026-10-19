import { AsyncLocalStorage } from "node:async_hooks";

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
import { ApiError, type WorkspaceClient } from "../../workspace-client";
import {
  contentTypeFromPath,
  FILES_MAX_READ_SIZE,
  isTextContentType,
} from "./defaults";

const logger = createLogger("connectors:files");

/**
 * Ambient span-attribute propagation for `FilesConnector.traced()`.
 *
 * Callers (e.g. the plugin's `_withAuthModeAttributes` wrapper) set extra
 * span attributes here via `runWithFilesSpanAttributes(attrs, fn)`. The
 * connector's `traced()` decorator reads them and merges them into the
 * span it creates around the SDK call. This lets the plugin tag spans with
 * `files.auth_mode` without opening a duplicate `files.<op>` span.
 *
 * AsyncLocalStorage is used so concurrent requests don't see each other's
 * attributes. Outside an active scope, `getStore()` returns `undefined` and
 * the connector falls back to the static attribute set.
 */
const filesSpanAttributesStorage = new AsyncLocalStorage<
  Record<string, string>
>();

/**
 * Run `fn` with the supplied attributes attached to whatever span the
 * `FilesConnector` opens for its SDK call. Used to propagate request-scoped
 * attributes (e.g. `files.auth_mode`) onto the connector's span without
 * opening a parent span — avoids the 2x span allocation that
 * `startActiveSpan` parented otherwise.
 */
export function runWithFilesSpanAttributes<T>(
  attributes: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  return filesSpanAttributesStorage.run(attributes, fn);
}

/**
 * The modular SDK throws `@databricks/sdk-core`'s `ApiError` (status on
 * `httpStatusCode`, code on `.code`), a different class from the wrapper's
 * `ApiError`. Convert it so `exists()` and the plugin's `instanceof ApiError`
 * / `.statusCode` mapping keep returning upstream 4xx statuses.
 */
function toWrapperApiError(error: unknown): unknown {
  if (
    error instanceof Error &&
    !(error instanceof ApiError) &&
    "httpStatusCode" in error &&
    typeof error.httpStatusCode === "number" &&
    error.httpStatusCode > 0
  ) {
    const code = "code" in error ? String(error.code) : "UNKNOWN";
    return new ApiError(
      error.message,
      code,
      error.httpStatusCode,
      undefined,
      [],
    );
  }
  return error;
}

/** Stream a file, mapped back to the legacy `DownloadResponse` shape. */
async function downloadFile(
  client: WorkspaceClient,
  resolvedPath: string,
): Promise<DownloadResponse> {
  const res = await client.files.downloadFile({ filePath: resolvedPath });
  return {
    "content-length":
      res.contentLength === undefined ? undefined : Number(res.contentLength),
    "content-type": res.contentType,
    contents: res.contents,
    "last-modified": res.lastModified,
  };
}

interface FilesConnectorConfig {
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

    // Pull any ambient attributes set by `runWithFilesSpanAttributes` (e.g.
    // `files.auth_mode` from the plugin layer). Static `attributes` win on
    // collision so callers can override per-call.
    const ambient = filesSpanAttributesStorage.getStore();

    return this.telemetry.startActiveSpan(
      `files.${operation}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "files.operation": operation,
          ...(ambient ?? {}),
          ...attributes,
        },
      },
      async (span: Span) => {
        try {
          const result = await fn(span);
          success = true;
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (thrown) {
          const error = toWrapperApiError(thrown);
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
      // TODO: return the SDK's camelCase entries as-is once appkit-ui's file
      // browser and the template's FilesPage read camelCase. Changing the
      // `/list` JSON is breaking for app code reading `is_directory` etc.
      const entries: DirectoryEntry[] = [];
      for await (const entry of client.files.listDirectoryContentsIter({
        directoryPath: resolvedPath,
      })) {
        entries.push({
          file_size: entry.fileSize,
          is_directory: entry.isDirectory,
          last_modified: entry.lastModified,
          name: entry.name,
          path: entry.path,
        });
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
    return this.traced("download", { "files.path": resolvedPath }, async () =>
      downloadFile(client, resolvedPath),
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
      // The modular `getFileMetadata` parses the empty HEAD body and drops the
      // response headers that carry the metadata, so read them off a raw HEAD.
      // TODO: switch to `client.files.getFileMetadata` once sdk-files builds the
      // response from the HEAD headers (as `downloadFile` already does).
      // Encode each segment so `#`, `?` and `%` in a name aren't parsed as URL
      // syntax by the raw seam (the typed SDK calls do the same).
      const encodedPath = resolvedPath
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      const res = await client.request({
        method: "HEAD",
        path: `/api/2.0/fs/files${encodedPath}`,
      });
      const contentLength = res.headers.get("content-length");
      return {
        contentLength:
          contentLength === null ? undefined : Number(contentLength),
        contentType: contentTypeFromPath(
          filePath,
          res.headers.get("content-type") ?? undefined,
          this.customContentTypes,
        ),
        lastModified: res.headers.get("last-modified") ?? undefined,
      };
    });
  }

  async upload(
    client: WorkspaceClient,
    filePath: string,
    contents: ReadableStream | Buffer | string,
    options?: { overwrite?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    const resolvedPath = this.resolvePath(filePath);

    return this.traced("upload", { "files.path": resolvedPath }, async () => {
      const overwrite = options?.overwrite ?? true;
      try {
        if (contents instanceof ReadableStream) {
          await client.files.uploadFile(
            { filePath: resolvedPath, contents, overwrite },
            { signal: options?.signal },
          );
        } else {
          // `uploadFile` takes only a ReadableStream, which goes out chunked
          // and can't be retried. Send in-memory contents as bytes instead, so
          // the request carries Content-Length and the transport can retry it.
          const encodedPath = resolvedPath
            .split("/")
            .map(encodeURIComponent)
            .join("/");
          const res = await client.request({
            method: "PUT",
            path: `/api/2.0/fs/files${encodedPath}`,
            query: { overwrite: String(overwrite) },
            headers: new Headers({
              "Content-Type": "application/octet-stream",
            }),
            body:
              typeof contents === "string"
                ? new TextEncoder().encode(contents)
                : new Uint8Array(contents),
            signal: options?.signal,
          });
          await res.body?.cancel();
        }
      } catch (e) {
        const wrapped = toWrapperApiError(e);
        if (!(wrapped instanceof ApiError)) throw e;
        logger.error(
          `Upload failed (${wrapped.statusCode}): ${wrapped.message}`,
        );
        const safeMessage =
          wrapped.message.length > 200
            ? `${wrapped.message.slice(0, 200)}…`
            : wrapped.message;
        throw new ApiError(
          `Upload failed: ${safeMessage}`,
          "UPLOAD_FAILED",
          wrapped.statusCode,
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
        await client.files.createDirectory({ directoryPath: resolvedPath });
      },
    );
  }

  async delete(client: WorkspaceClient, filePath: string): Promise<void> {
    const resolvedPath = this.resolvePath(filePath);
    return this.traced("delete", { "files.path": resolvedPath }, async () => {
      await client.files.deleteFile({ filePath: resolvedPath });
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

      const response = await downloadFile(client, resolvedPath);
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
