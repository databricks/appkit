// import type { BasePluginConfig } from "shared";
import type { files } from "@databricks/sdk-experimental";

// export interface IFilesConfig extends BasePluginConfig {
//   timeout?: number;
// }

// TODO: Add request/response types for file operations
export type DirectoryEntry = files.DirectoryEntry;
export type DownloadResponse = files.DownloadResponse;

export interface FileMetadata {
  contentLength: number | undefined;
  contentType: string | undefined;
  lastModified: string | undefined;
}

export interface FilePreview extends FileMetadata {
  textPreview: string | null;
  isText: boolean;
  isImage: boolean;
}
