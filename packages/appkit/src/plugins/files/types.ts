import type { files } from "@databricks/sdk-experimental";
import type { BasePluginConfig, IAppRequest } from "shared";

/**
 * Per-volume configuration options.
 */
export interface VolumeConfig {
  /** Maximum upload size in bytes for this volume. Inherits from plugin-level `maxUploadSize` if not set. */
  maxUploadSize?: number;
  /** Map of file extensions to MIME types for this volume. Inherits from plugin-level `customContentTypes` if not set. */
  customContentTypes?: Record<string, string>;
  /** Maximum number of concurrent file operations for bulk methods. Defaults to 8. */
  concurrency?: number;
}

/**
 * Options for bulk file operations.
 */
export interface BulkOperationOptions {
  /** Override the volume-level concurrency limit for this call. */
  concurrency?: number;
}

/**
 * Per-file result from a bulk upload operation.
 */
export interface BulkResult {
  /** The file path that was operated on. */
  path: string;
  /** Whether the operation succeeded for this file. */
  success: boolean;
  /** Error message if the operation failed. Only present when `success` is `false`. */
  error?: string;
  /** Number of bytes written. Only present when `success` is `true`. */
  bytesWritten?: number;
}

/**
 * A single item yielded by {@link VolumeAPI.bulkDownload}.
 * Check `error` to determine success or failure for each file.
 */
export interface BulkDownloadItem {
  /** The file path that was downloaded (or attempted). */
  path: string;
  /** File content on success, `null` on failure. */
  content: Buffer | null;
  /** Error message if the download failed. */
  error?: string;
}

/**
 * User-facing API for a single volume.
 * Prefer OBO access via `app.files("volumeKey").asUser(req).list()`.
 */
export interface VolumeAPI {
  list(directoryPath?: string): Promise<DirectoryEntry[]>;
  read(filePath: string, options?: { maxSize?: number }): Promise<string>;
  download(filePath: string): Promise<DownloadResponse>;
  exists(filePath: string): Promise<boolean>;
  metadata(filePath: string): Promise<FileMetadata>;
  upload(
    filePath: string,
    contents: ReadableStream | Buffer | string,
    options?: { overwrite?: boolean },
  ): Promise<void>;
  createDirectory(directoryPath: string): Promise<void>;
  delete(filePath: string): Promise<void>;
  preview(filePath: string): Promise<FilePreview>;

  /**
   * Upload multiple files in a single call with concurrency control.
   * All files must be known upfront. For incremental uploads, use {@link bulkUploadStream}.
   * Partial failures do not abort the batch — each file gets its own {@link BulkResult}.
   */
  bulkUpload(
    files: { path: string; content: Buffer }[],
    options?: BulkOperationOptions,
  ): Promise<BulkResult[]>;

  /**
   * Upload files from an async iterable with concurrency control.
   * The caller declares the expected file count; the operation resolves when all files
   * have been received and processed (or the stream ends).
   */
  bulkUploadStream(
    fileCount: number,
    stream: AsyncIterable<{ path: string; content: Buffer }>,
    options?: BulkOperationOptions,
  ): Promise<BulkResult[]>;

  /**
   * Download multiple files as a streaming async iterable.
   * Each yielded item includes the file content on success or an error string on failure.
   * Failed downloads do not abort the stream.
   */
  bulkDownload(
    paths: string[],
    options?: BulkOperationOptions,
  ): AsyncIterable<BulkDownloadItem>;
}

/**
 * Configuration for the Files plugin.
 */
export interface IFilesConfig extends BasePluginConfig {
  /** Operation timeout in milliseconds. Overrides the per-tier defaults. */
  timeout?: number;
  /** Named volumes to expose. Each key becomes a volume accessor (e.g. `uploads`, `exports`). */
  volumes?: Record<string, VolumeConfig>;
  /** Map of file extensions to MIME types that takes priority over the built-in extension map. */
  customContentTypes?: Record<string, string>;
  /** Maximum upload size in bytes. Defaults to 5 GB (Databricks Files API v2 limit). */
  maxUploadSize?: number;
}

/** A single entry returned when listing a directory. Re-exported from `@databricks/sdk-experimental`. */
export type DirectoryEntry = files.DirectoryEntry;

/** Response object for file downloads containing a readable stream. Re-exported from `@databricks/sdk-experimental`. */
export type DownloadResponse = files.DownloadResponse;

/**
 * Metadata for a file stored in a Unity Catalog volume.
 */
export interface FileMetadata {
  /** File size in bytes. */
  contentLength: number | undefined;
  /** MIME content type of the file. */
  contentType: string | undefined;
  /** ISO 8601 timestamp of the last modification. */
  lastModified: string | undefined;
}

/**
 * Preview information for a file, extending {@link FileMetadata} with content hints.
 */
export interface FilePreview extends FileMetadata {
  /** First portion of text content, or `null` for non-text files. */
  textPreview: string | null;
  /** Whether the file is detected as a text format. */
  isText: boolean;
  /** Whether the file is detected as an image format. */
  isImage: boolean;
}

/**
 * Volume handle returned by `app.files("volumeKey")`.
 *
 * - `asUser(req)` — executes on behalf of the user (recommended).
 * - Direct methods (e.g. `.list()`) — execute as the service principal (logs a warning encouraging OBO).
 */
export type VolumeHandle = VolumeAPI & {
  asUser: (req: IAppRequest) => VolumeAPI;
};

/**
 * The public API shape of the files plugin.
 * Callable to select a volume, with a `.volume()` alias.
 *
 * @example
 * ```ts
 * // OBO access (recommended)
 * appKit.files("uploads").asUser(req).list()
 *
 * // Service principal access (logs a warning)
 * appKit.files("uploads").list()
 *
 * // Named accessor
 * const vol = appKit.files.volume("uploads")
 * await vol.asUser(req).list()
 * ```
 */
export interface FilesExport {
  (volumeKey: string): VolumeHandle;
  volume: (volumeKey: string) => VolumeHandle;
}
