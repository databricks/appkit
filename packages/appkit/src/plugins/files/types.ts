import type { files } from "@databricks/sdk-experimental";
import type { BasePluginConfig, IAppRequest } from "shared";
import type { FilePolicy } from "./policy";

/**
 * Per-volume configuration options.
 */
export interface VolumeConfig {
  /** Maximum upload size in bytes for this volume. Inherits from plugin-level `maxUploadSize` if not set. */
  maxUploadSize?: number;
  /** Map of file extensions to MIME types for this volume. Inherits from plugin-level `customContentTypes` if not set. */
  customContentTypes?: Record<string, string>;
  /**
   * Access-control policy for this volume. When set, operations execute as the
   * service principal and the policy decides whether the action is allowed.
   */
  policy?: FilePolicy;
  /**
   * Per-volume auth mode. When `"on-behalf-of-user"`, route handlers and
   * programmatic calls execute Unity Catalog SDK operations as the end user
   * instead of the service principal. Inherits from `IFilesConfig.auth` if
   * not set; defaults to `"service-principal"`.
   */
  auth?: "service-principal" | "on-behalf-of-user";
}

/**
 * User-facing API for a single volume.
 *
 * Which identity executes each operation depends on the volume's effective
 * `auth` mode (resolved from `VolumeConfig.auth` ?? `IFilesConfig.auth` ??
 * `"service-principal"`):
 * - SP volumes (`auth: "service-principal"`): operations execute as the
 *   service principal.
 * - OBO volumes (`auth: "on-behalf-of-user"`): operations invoked through
 *   the HTTP routes execute as the end user (the token from
 *   `x-forwarded-access-token` is used to build the SDK client). For
 *   programmatic calls outside an HTTP route, see `VolumeHandle.asUser(req)`
 *   to opt into per-user execution explicitly.
 *
 * When a policy is configured on the volume, every call is checked against
 * that policy with the appropriate identity (service principal vs end user).
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
  /**
   * Plugin-level default auth mode for all volumes. Each volume can override
   * via `VolumeConfig.auth`. Defaults to `"service-principal"` if not set.
   */
  auth?: "service-principal" | "on-behalf-of-user";
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
 * Default execution identity follows the volume's effective `auth` mode:
 * - SP volumes (`auth: "service-principal"`): methods execute as the service
 *   principal and the volume policy (if configured) sees
 *   `{ isServicePrincipal: true }`.
 * - OBO volumes (`auth: "on-behalf-of-user"`): methods invoked from inside
 *   an HTTP route handler execute as the end user (the route wires the
 *   request token into a `runInUserContext` scope before calling SDK code).
 *
 * `asUser(req)` re-wraps the API with the real user identity from the
 * request — useful for per-user policy checks when calling the API outside
 * an HTTP route. In production it throws `AuthenticationError.missingToken`
 * when the `x-forwarded-user` header is missing; in development
 * (`NODE_ENV === "development"`) it falls back to the service principal so
 * local testing without a reverse proxy continues to work.
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
 * // Service principal access
 * appKit.files("uploads").list()
 *
 * // With policy: pass user identity for access control
 * appKit.files("uploads").asUser(req).list()
 *
 * // Named accessor
 * const vol = appKit.files.volume("uploads")
 * await vol.list()
 * ```
 */
export interface FilesExport {
  (volumeKey: string): VolumeHandle;
  volume: (volumeKey: string) => VolumeHandle;
}
