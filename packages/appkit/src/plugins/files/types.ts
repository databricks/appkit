import type { files } from "@databricks/sdk-experimental";
import type { BasePluginConfig } from "shared";

/**
 * Configuration for the Files plugin.
 */
export interface IFilesConfig extends BasePluginConfig {
  /** Operation timeout in milliseconds. Overrides the per-tier defaults. */
  timeout?: number;
  /** Absolute volume path used to resolve relative file paths (e.g. `"/Volumes/catalog/schema/vol"`). */
  defaultVolume?: string;
  /** Map of file extensions to MIME types that takes priority over the built-in extension map. */
  customContentTypes?: Record<string, string>;
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
