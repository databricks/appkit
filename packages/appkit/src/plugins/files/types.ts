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
}

/**
 * User-facing API for a single volume.
 * Prefer OBO access via `app.files("volumeKey").asUser(req).list()`.
 */
export interface VolumeAPI {
  list(directoryPath?: string): Promise<DirectoryEntry[]>;
  read(filePath: string, options?: { maxSize?: number }): Promise<string>;
  /** Streams the file through the AppKit server (proxied). Use when the server needs to process the file or when clients can't reach cloud storage directly. */
  download(filePath: string): Promise<DownloadResponse>;
  /**
   * Returns a pre-signed URL pointing directly to cloud storage (S3/ADLS/GCS), bypassing the server proxy.
   * Use when the client should fetch the file directly — better for large files and reducing server load.
   * OBO-only: throws if called without user context.
   * @param filePath - Path to the file within the volume.
   * @param options.expireInSeconds - URL lifetime in seconds (1–3600, default 900).
   */
  createDownloadUrl(
    filePath: string,
    options?: { expireInSeconds?: number },
  ): Promise<PresignedDownloadUrl>;
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
}

/**
 * Response from the UC pre-signed download URL endpoint.
 * The `url` points directly to cloud storage (S3/ADLS/GCS) and bypasses the Databricks Apps proxy.
 */
export interface PresignedDownloadUrl {
  /** Pre-signed URL pointing directly to cloud storage. */
  url: string;
  /**
   * Headers that the client must include when fetching the pre-signed URL.
   * May contain cloud-provider authentication tokens — do not log or expose beyond the immediate download.
   */
  headers: Record<string, string>;
  /** ISO 8601 timestamp when the pre-signed URL expires. */
  expiresAt: string;
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
 * - `asUser(req)` — executes on behalf of the user (required).
 * - Direct methods (e.g. `.list()`) — throw if called without user context.
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
 * // OBO access (required)
 * appKit.files("uploads").asUser(req).list()
 *
 * // Service principal access (throws — use asUser instead)
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
