import type { files } from "@databricks/sdk-experimental";
import type { BasePluginConfig, IAppRequest } from "shared";
import type { FilePolicy } from "./policy";

/**
 * Per-volume configuration options.
 */
export interface VolumeConfig {
  /** Maximum upload size in bytes for this volume. Inherits from plugin-level `maxUploadSize` if not set. */
  maxUploadSize?: number;
  /**
   * Maximum byte length the `/read` endpoint will stream before aborting with
   * `413 Payload Too Large`. Inherits from plugin-level `maxReadSize` if not
   * set; defaults to 10 MB. `/download` and `/raw` are unaffected.
   */
  maxReadSize?: number;
  /** Map of file extensions to MIME types for this volume. Inherits from plugin-level `customContentTypes` if not set. */
  customContentTypes?: Record<string, string>;
  /**
   * Access-control policy for this volume. When set, operations execute as the
   * service principal and the policy decides whether the action is allowed.
   */
  policy?: FilePolicy;
  /**
   * Per-volume auth mode. When `"on-behalf-of-user"`, HTTP route handlers
   * execute Unity Catalog SDK operations as the end user (using the
   * `x-forwarded-access-token` and `x-forwarded-user` headers injected by
   * the Databricks Apps reverse proxy) instead of the service principal.
   * Inherits from `IFilesConfig.auth` if not set; defaults to
   * `"service-principal"`.
   *
   * **Permission scope**:
   * - `"service-principal"`: the app's SP needs `WRITE_VOLUME` (or
   *   read-equivalent) on the UC volume.
   * - `"on-behalf-of-user"`: each end user needs `WRITE_VOLUME` (or
   *   read-equivalent) on the UC volume; the SP itself does not need
   *   direct volume permissions.
   *
   * In production, OBO requests with a missing `x-forwarded-access-token`
   * return `401`. In development (`NODE_ENV === "development"`) they fall
   * back to the SP with a single warning so local testing without a
   * reverse proxy continues to work.
   *
   * @example Service-principal volume (default)
   * ```ts
   * files({
   *   volumes: {
   *     exports: {
   *       auth: "service-principal", // explicit; same as omitting
   *       policy: files.policy.publicRead(),
   *     },
   *   },
   * });
   * ```
   *
   * @example On-behalf-of-user volume
   * ```ts
   * files({
   *   volumes: {
   *     "user-uploads": {
   *       auth: "on-behalf-of-user",
   *       // Policies see the real end user identity here.
   *       policy: (action, _resource, user) =>
   *         !user.isServicePrincipal,
   *     },
   *   },
   * });
   * ```
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
   * Plugin-level default for the `/read` endpoint's response size cap.
   * Inherited by volumes without their own `maxReadSize`. Defaults to 10 MB.
   */
  maxReadSize?: number;
  /**
   * Plugin-level default auth mode for all volumes. Volumes without an
   * explicit `auth` field inherit this default; volumes that set their own
   * `VolumeConfig.auth` override it. Defaults to `"service-principal"` if
   * not set.
   *
   * Resolution order (per volume):
   * `VolumeConfig.auth` > `IFilesConfig.auth` > `"service-principal"`.
   *
   * @example Mark every volume OBO unless explicitly overridden
   * ```ts
   * files({
   *   auth: "on-behalf-of-user",
   *   volumes: {
   *     // Inherits "on-behalf-of-user" from the plugin-level default.
   *     "user-uploads": { policy: files.policy.allowAll() },
   *     // Overrides the plugin default to run as the SP.
   *     reports: {
   *       auth: "service-principal",
   *       policy: files.policy.publicRead(),
   *     },
   *   },
   * });
   * ```
   *
   * @example Default to service-principal (the implicit default)
   * ```ts
   * files({
   *   // No `auth` set → all volumes default to "service-principal".
   *   volumes: {
   *     exports: { policy: files.policy.publicRead() },
   *   },
   * });
   * ```
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
 * `asUser(req)` is a hard override: regardless of the volume's `auth`
 * setting (SP or OBO), the returned API runs every SDK call inside
 * `runInUserContext` with the user identity extracted from the request,
 * so the underlying `WorkspaceClient` is the user-token client. This makes
 * `appKit.files("sp-vol").asUser(req).list()` actually execute as the end
 * user, even on a service-principal-configured volume.
 *
 * In production `asUser` throws `AuthenticationError.missingToken` when the
 * `x-forwarded-user` header is missing. In development
 * (`NODE_ENV === "development"`) it logs a warning and falls back to the
 * service principal so local testing without a reverse proxy continues to
 * work — in that fallback no `runInUserContext` wrap is applied and SDK
 * calls execute as the SP, identical to pre-OBO behavior.
 *
 * @remarks Behavior change: prior to OBO support, `asUser(req)` only
 * influenced the policy user passed to the volume policy — the underlying
 * SDK call still ran as the service principal. With OBO support landed,
 * `asUser` now also forces the SDK call to run as the user. Any caller
 * that relied on the pre-OBO behavior (policy sees user, SDK runs as SP)
 * must remove the `asUser` wrap.
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
