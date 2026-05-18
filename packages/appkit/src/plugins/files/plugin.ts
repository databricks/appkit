import { STATUS_CODES } from "node:http";
import { Readable } from "node:stream";
import { ApiError } from "@databricks/sdk-experimental";
import type express from "express";
import type {
  AgentToolDefinition,
  IAppRouter,
  PluginExecutionSettings,
  ToolProvider,
} from "shared";
import { z } from "zod";
import {
  contentTypeFromPath,
  FILES_MAX_READ_SIZE,
  FilesConnector,
  isSafeInlineContentType,
  runWithFilesSpanAttributes,
  validateCustomContentTypes,
} from "../../connectors/files";
import {
  getCurrentUserId,
  getExecutionContext,
  getWorkspaceClient,
  runInUserContext,
  ServiceContext,
  type UserContext,
} from "../../context";
import { isUserContext } from "../../context/user-context";
import { buildToolkitEntries } from "../../core/agent/build-toolkit";
import {
  defineTool,
  executeFromRegistry,
  type ToolRegistry,
  toolsFromRegistry,
} from "../../core/agent/tools/define-tool";
import { AuthenticationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest, ResourceRequirement } from "../../registry";
import { ResourceType } from "../../registry";
import {
  FILES_DOWNLOAD_DEFAULTS,
  FILES_MAX_UPLOAD_SIZE,
  FILES_READ_DEFAULTS,
  FILES_WRITE_DEFAULTS,
} from "./defaults";
import { parentDirectory, sanitizeFilename } from "./helpers";
import manifest from "./manifest.json";
import {
  type FileAction,
  type FilePolicyUser,
  type FileResource,
  PolicyDeniedError,
  policy,
} from "./policy";
import type {
  FilesExport,
  IFilesConfig,
  VolumeAPI,
  VolumeConfig,
  VolumeHandle,
} from "./types";

const logger = createLogger("files");

export class FilesPlugin extends Plugin implements ToolProvider {
  name = "files";

  /** Plugin manifest declaring metadata and resource requirements. */
  static manifest = manifest as PluginManifest;
  protected static description = "Files plugin for Databricks file operations";
  protected declare config: IFilesConfig;

  private volumeConnectors: Record<string, FilesConnector> = {};
  private volumeConfigs: Record<string, VolumeConfig> = {};
  private volumeKeys: string[] = [];
  private tools: ToolRegistry = {};

  /**
   * Scans `process.env` for `DATABRICKS_VOLUME_*` keys and merges them with
   * any explicitly configured volumes. Explicit config wins for per-volume
   * overrides; auto-discovered volumes get default `{}` config.
   */
  static discoverVolumes(config: IFilesConfig): Record<string, VolumeConfig> {
    const explicit = config.volumes ?? {};
    const discovered: Record<string, VolumeConfig> = {};

    const prefix = "DATABRICKS_VOLUME_";
    for (const key of Object.keys(process.env)) {
      if (!key.startsWith(prefix)) continue;
      const suffix = key.slice(prefix.length);
      if (!suffix) continue;
      if (!process.env[key]) continue;
      const volumeKey = suffix.toLowerCase();
      if (!(volumeKey in explicit)) {
        discovered[volumeKey] = {};
      }
    }

    return { ...discovered, ...explicit };
  }

  /**
   * Generates resource requirements dynamically from discovered + configured volumes.
   * Each volume key maps to a `DATABRICKS_VOLUME_{KEY_UPPERCASE}` env var.
   *
   * ## Per-volume permission scope (SP vs OBO)
   *
   * The returned manifest entries describe a single permission grant per
   * volume, but the *grantee* depends on the volume's `auth` setting at
   * runtime — and that distinction is **not** expressed in the manifest
   * today:
   *
   * - **Service-principal volumes** (the default, `auth: "service-principal"`):
   *   the app's service principal needs `WRITE_VOLUME` (or read-equivalent)
   *   on the UC volume. This matches the manifest entry as written.
   * - **On-behalf-of-user volumes** (`auth: "on-behalf-of-user"`): SDK calls
   *   execute as the **end user**, so the *user* — not the SP — must hold
   *   `WRITE_VOLUME` (or read-equivalent) on the UC volume. The SP only
   *   needs to be allowed to mint user-token requests; it does not need
   *   direct volume permissions.
   *
   * The static manifest cannot currently express this per-volume split, so
   * callers configuring OBO volumes must communicate the per-user permission
   * requirement out-of-band (docs, runbooks, deployment scripts) until the
   * manifest schema gains a per-volume auth scope field.
   */
  static getResourceRequirements(config: IFilesConfig): ResourceRequirement[] {
    const volumes = FilesPlugin.discoverVolumes(config);
    // TODO: extend plugin-manifest.schema.json to express per-volume auth
    // scope so OBO volumes can declare end-user-required permissions in the
    // manifest itself.
    return Object.keys(volumes).map((key) => ({
      type: ResourceType.VOLUME,
      alias: `volume-${key}`,
      resourceKey: `volume-${key}`,
      description: `Unity Catalog Volume for "${key}" file storage`,
      permission: "WRITE_VOLUME",
      fields: {
        path: {
          env: `DATABRICKS_VOLUME_${key.toUpperCase()}`,
          description: `Volume path for "${key}" (e.g. /Volumes/catalog/schema/volume_name)`,
        },
      },
      required: true,
    }));
  }

  /**
   * Extraction for `VolumeHandle.asUser(req)`. In production we require BOTH
   * `x-forwarded-user` and `x-forwarded-access-token`, and throw
   * `AuthenticationError.missingToken` if either is missing — otherwise a
   * request with only `x-forwarded-user: alice` would let policies see Alice
   * as a "real user" (`isServicePrincipal: false`) while the SDK call below
   * falls through to the SP client because `_buildUserContextOrNull` returns
   * `null`. Net effect: policy approves the user, SDK runs as SP, privilege
   * confusion (CWE-639/863).
   *
   * In development (`NODE_ENV === "development"`) we keep a local-loop
   * convenience: if either header is missing we emit a single warning and
   * return a policy user explicitly marked `isServicePrincipal: true`, so
   * even in dev a `usersOnly`-style policy that gates on
   * `!user.isServicePrincipal` cannot be tricked. The matching SDK execution
   * path also falls through to the SP client (no `runInUserContext` wrap),
   * so the policy user and the SDK identity stay aligned.
   */
  private _extractUser(req: express.Request): FilePolicyUser {
    const userId = req.header("x-forwarded-user")?.trim();
    const token = req.header("x-forwarded-access-token")?.trim();
    if (userId && token) return { id: userId, isServicePrincipal: false };
    if (process.env.NODE_ENV === "development") {
      logger.warn(
        "asUser(req) called without complete x-forwarded-user + x-forwarded-access-token headers — " +
          "falling back to service principal identity (dev mode). " +
          "In production this request would 401.",
      );
      return { id: getCurrentUserId(), isServicePrincipal: true };
    }
    if (!token) {
      throw AuthenticationError.missingToken(
        "Missing x-forwarded-access-token header for asUser(req). Both x-forwarded-user and x-forwarded-access-token are required.",
      );
    }
    throw AuthenticationError.missingToken(
      "Missing x-forwarded-user header. Cannot resolve user ID for asUser(req).",
    );
  }

  /**
   * Extraction for OBO (on-behalf-of-user) volumes on the HTTP path. Both the
   * `x-forwarded-access-token` and `x-forwarded-user` headers must be present
   * for a valid end-user identity. When the token is missing:
   * - In production we throw `AuthenticationError.missingToken` so the route
   *   responds with 401 (no SDK call is made).
   * - In development (`NODE_ENV === "development"`) we emit a single warning
   *   and fall back to the service principal identity so local testing
   *   without a reverse proxy continues to work.
   */
  private _extractOboUser(req: express.Request): FilePolicyUser {
    const token = req.header("x-forwarded-access-token")?.trim();
    const userId = req.header("x-forwarded-user")?.trim();
    if (token && userId) {
      return { id: userId, isServicePrincipal: false };
    }
    if (!token && process.env.NODE_ENV === "development") {
      logger.warn(
        "OBO volume requested without x-forwarded-access-token — falling back to service principal identity (dev mode). " +
          "In production this request would 401.",
      );
      return { id: getCurrentUserId(), isServicePrincipal: true };
    }
    throw AuthenticationError.missingToken(
      !token
        ? "Missing x-forwarded-access-token header for on-behalf-of-user volume."
        : "Missing x-forwarded-user header for on-behalf-of-user volume.",
    );
  }

  /**
   * Check the policy for a volume. No-op if no policy is configured.
   * Throws `PolicyDeniedError` if denied.
   */
  private async _checkPolicy(
    volumeKey: string,
    action: FileAction,
    path: string,
    user: FilePolicyUser,
    resourceOverrides?: Partial<FileResource>,
  ): Promise<void> {
    const policyFn = this.volumeConfigs[volumeKey]?.policy;
    if (typeof policyFn !== "function") return;

    const resource: FileResource = {
      path,
      volume: volumeKey,
      ...resourceOverrides,
    };
    const allowed = await policyFn(action, resource, user);
    if (!allowed) {
      const userId = user.isServicePrincipal ? "<service-principal>" : user.id;
      logger.warn(
        'Policy denied "%s" on volume "%s" for user "%s"',
        action,
        volumeKey,
        userId,
      );
      throw new PolicyDeniedError(action, volumeKey);
    }
  }

  /**
   * HTTP-level wrapper around `_checkPolicy`.
   * Selects the policy user based on the volume's auth mode (resolved via
   * `_resolveAuth`):
   * - `"service-principal"` (default): use the `x-forwarded-user` header when
   *   present, otherwise fall back to the SP identity (legacy behavior).
   * - `"on-behalf-of-user"`: require `x-forwarded-access-token` (and the
   *   matching `x-forwarded-user`); 401 in production when missing,
   *   dev-fallback to SP identity in development.
   * Then runs the volume policy (403 on denial, 500 on unexpected error).
   * Returns `true` if the request may proceed, `false` if a response was sent.
   *
   * NOTE: This method only selects which identity the *policy* sees. The
   * matching SDK execution identity is selected separately by
   * `_resolveAuthForRequest` and applied via `_runWithAuth` /
   * `runInUserContext` in each handler. The two selections are designed to
   * converge on the same identity per the policy-user matrix in the docs —
   * see `docs/docs/plugins/files.md#policy-user-matrix`.
   */
  private async _enforcePolicy(
    req: express.Request,
    res: express.Response,
    volumeKey: string,
    action: FileAction,
    path: string,
    resourceOverrides?: Partial<FileResource>,
  ): Promise<boolean> {
    let user: FilePolicyUser;
    try {
      const auth = this._resolveAuth(volumeKey);
      if (auth === "on-behalf-of-user") {
        user = this._extractOboUser(req);
      } else {
        const headerUserId = req.header("x-forwarded-user")?.trim();
        if (headerUserId) {
          user = { id: headerUserId };
        } else {
          logger.debug(
            "No x-forwarded-user header — proceeding with service principal identity for policy evaluation.",
          );
          user = { id: getCurrentUserId(), isServicePrincipal: true };
        }
      }
    } catch (error) {
      if (error instanceof AuthenticationError) {
        logger.warn(
          "Authentication failed during policy evaluation for volume %s: %O",
          volumeKey,
          error,
        );
        res.status(401).json({ error: "Unauthorized", plugin: this.name });
        return false;
      }
      throw error;
    }

    try {
      await this._checkPolicy(volumeKey, action, path, user, resourceOverrides);
    } catch (error) {
      if (error instanceof PolicyDeniedError) {
        res.status(403).json({ error: error.message, plugin: this.name });
        return false;
      }
      // A crashing policy is treated as a server error (fail closed).
      logger.error("Policy function threw on volume %s: %O", volumeKey, error);
      res.status(500).json({
        error: "Policy evaluation failed",
        plugin: this.name,
      });
      return false;
    }

    return true;
  }

  constructor(config: IFilesConfig) {
    super(config);
    this.config = config;

    if (config.customContentTypes) {
      validateCustomContentTypes(config.customContentTypes);
    }

    const volumes = FilesPlugin.discoverVolumes(config);
    this.volumeKeys = Object.keys(volumes);

    for (const key of this.volumeKeys) {
      const volumeCfg = volumes[key];
      const envVar = `DATABRICKS_VOLUME_${key.toUpperCase()}`;
      const volumePath = process.env[envVar];

      // Merge per-volume config with plugin-level defaults
      const mergedConfig: VolumeConfig = {
        maxUploadSize: volumeCfg.maxUploadSize ?? config.maxUploadSize,
        maxReadSize: volumeCfg.maxReadSize ?? config.maxReadSize,
        customContentTypes:
          volumeCfg.customContentTypes ?? config.customContentTypes,
        policy: volumeCfg.policy ?? policy.publicRead(),
        auth: volumeCfg.auth,
      };
      this.volumeConfigs[key] = mergedConfig;

      this.volumeConnectors[key] = new FilesConnector({
        defaultVolume: volumePath,
        timeout: config.timeout,
        telemetry: config.telemetry,
        customContentTypes: mergedConfig.customContentTypes,
      });

      Object.assign(this.tools, this._defineVolumeTools(key));

      // Warn at startup for volumes without an explicit policy
      if (!volumeCfg.policy) {
        logger.warn(
          'Volume "%s" has no explicit policy — defaulting to publicRead(). ' +
            "This also matches header-less HTTP requests (which run as the service principal). " +
            "Set a policy in files({ volumes: { %s: { policy: ... } } }) to silence this warning.",
          key,
          key,
        );
      }
    }
  }

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      name: "volumes",
      method: "get",
      path: "/volumes",
      handler: async (_req: express.Request, res: express.Response) => {
        res.json({ volumes: this.volumeKeys });
      },
    });

    this.route(router, {
      name: "list",
      method: "get",
      path: "/:volumeKey/list",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleList(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "read",
      method: "get",
      path: "/:volumeKey/read",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleRead(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "download",
      method: "get",
      path: "/:volumeKey/download",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleDownload(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "raw",
      method: "get",
      path: "/:volumeKey/raw",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleRaw(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "exists",
      method: "get",
      path: "/:volumeKey/exists",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleExists(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "metadata",
      method: "get",
      path: "/:volumeKey/metadata",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleMetadata(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "preview",
      method: "get",
      path: "/:volumeKey/preview",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handlePreview(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "upload",
      method: "post",
      path: "/:volumeKey/upload",
      skipBodyParsing: true,
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleUpload(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "mkdir",
      method: "post",
      path: "/:volumeKey/mkdir",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleMkdir(req, res, connector, volumeKey);
      },
    });

    this.route(router, {
      name: "delete",
      method: "delete",
      path: "/:volumeKey",
      handler: async (req: express.Request, res: express.Response) => {
        const { connector, volumeKey } = this._resolveVolume(req, res);
        if (!connector) return;
        await this._handleDelete(req, res, connector, volumeKey);
      },
    });
  }

  /**
   * Resolve `:volumeKey` from the request. Returns the connector and key,
   * or sends a 404 and returns `{ connector: undefined }`.
   */
  private _resolveVolume(
    req: express.Request,
    res: express.Response,
  ):
    | { connector: FilesConnector; volumeKey: string }
    | { connector: undefined; volumeKey: undefined } {
    const volumeKey = req.params.volumeKey;
    const connector = this.volumeConnectors[volumeKey];
    if (!connector) {
      const safeKey = volumeKey.replace(/[^a-zA-Z0-9_-]/g, "");
      res.status(404).json({
        error: `Unknown volume "${safeKey}"`,
        plugin: this.name,
      });
      return { connector: undefined, volumeKey: undefined };
    }
    return { connector, volumeKey };
  }

  /**
   * Extract `req.query.path` as a single string when present.
   *
   * Express coerces repeated query parameters (`?path=a&path=b`) to a string
   * array and dotted/nested params (`?path[k]=v`) to an object. Reject those
   * with `400` instead of letting non-string values reach `_isValidPath` /
   * `connector.resolvePath`, which would misbehave on arrays or objects.
   *
   * Returns `{ path }` (with `path` either a string or `undefined` when the
   * query parameter was absent) on success. Returns `undefined` and writes a
   * `400` response when the value is not a single string — callers must
   * check the return for `undefined` before continuing.
   */
  private _readPathQuery(
    req: express.Request,
    res: express.Response,
  ): { path: string | undefined } | undefined {
    const value = req.query.path;
    if (value === undefined || typeof value === "string") {
      return { path: value };
    }
    res.status(400).json({
      error: "path query parameter must be a single string",
      plugin: this.name,
    });
    return undefined;
  }

  /**
   * Validate a file/directory path from user input.
   * Returns `true` if valid, or an error message string if invalid.
   */
  private _isValidPath(path: string | undefined): true | string {
    if (!path) return "path is required";
    if (path.length > 4096)
      return `path exceeds maximum length of 4096 characters (got ${path.length})`;
    if (path.includes("\0")) return "path must not contain null bytes";
    return true;
  }

  private _readSettings(
    cacheKey: (string | number | object)[],
    authMode: "service-principal" | "on-behalf-of-user",
  ): PluginExecutionSettings {
    // OBO volumes: disable list/read cache. The cache layer is keyed by
    // `getCurrentUserId()`, so user A's writes can only invalidate user A's
    // cache entry — user B would continue to see stale data for the same
    // volume/path until TTL. Disabling caching trades read performance for
    // correctness; the alternative is a per-(volume, path) generation
    // counter folded into the cache key on writes (a future enhancement).
    const isObo = authMode === "on-behalf-of-user";
    const cache = isObo
      ? { ...FILES_READ_DEFAULTS.cache, enabled: false, cacheKey }
      : { ...FILES_READ_DEFAULTS.cache, cacheKey };
    return {
      default: {
        ...FILES_READ_DEFAULTS,
        cache,
        telemetryInterceptor: {
          attributes: this._authModeAttributes(authMode),
        },
      },
    };
  }

  private _writeSettings(
    authMode: "service-principal" | "on-behalf-of-user",
  ): PluginExecutionSettings {
    return {
      default: {
        ...FILES_WRITE_DEFAULTS,
        telemetryInterceptor: {
          attributes: this._authModeAttributes(authMode),
        },
      },
    };
  }

  private _downloadSettings(
    authMode: "service-principal" | "on-behalf-of-user",
  ): PluginExecutionSettings {
    return {
      default: {
        ...FILES_DOWNLOAD_DEFAULTS,
        telemetryInterceptor: {
          attributes: this._authModeAttributes(authMode),
        },
      },
    };
  }

  /**
   * Invalidate cached list entries for a directory after a write operation.
   * Must produce the SAME cache-key shape that `_handleList` stored under.
   * `_handleList` builds its key from `req.query.path`: when `path` is
   * provided it uses `connector.resolvePath(path)`, otherwise it uses the
   * sentinel `"__root__"`. The invalidation here must derive the matching
   * directory from the FILE path being written:
   *
   * - `"/Volumes/c/s/v/foo/bar.txt"` → `parentDirectory` returns
   *   `"/Volumes/c/s/v/foo"` → resolved path key.
   * - `"/bar.txt"` and `"bar.txt"` → root-level files: matching list cache
   *   was a rootless `list()` call → `"__root__"` sentinel.
   * - `"/Volumes/c/s/v/bar.txt"` → `parentDirectory` returns the UC
   *   volume path (`"/Volumes/c/s/v"`). That's also root-level — a
   *   rootless `list()` would have cached under `"__root__"`, while
   *   `list("/Volumes/c/s/v")` and `list("/Volumes/c/s/v/")` would have
   *   cached under the volume path with and without trailing slash. All
   *   three are invalidated.
   *
   * On OBO volumes the read cache is disabled (see `_readSettings`), so
   * invalidation is a no-op here for `mode === "on-behalf-of-user"`. The
   * cache layer is keyed by `getCurrentUserId()`, so user A's writes can
   * only invalidate user A's cache entry — user B would otherwise see stale
   * data for the same volume/path until TTL. Disabling the cache on OBO
   * trades read performance for correctness; the alternative is a
   * per-(volume, path) generation counter folded into the cache key on
   * writes (a future enhancement).
   *
   * Best-effort: a thrown `connector.resolvePath` (e.g. on malformed input)
   * is swallowed here. Invalidation is purely an optimization signal — a
   * missed delete only costs read freshness, not correctness, and
   * propagating the error would convert a successful write into an HTTP
   * 500.
   *
   * Returns a `Promise<void>`; callers MUST `await` this before sending the
   * HTTP success response so a follow-up `GET /list` issued in the same tick
   * cannot race the underlying `cache.delete()` and observe stale data.
   */
  private async _invalidateListCache(
    volumeKey: string,
    writtenPath: string,
    connector: FilesConnector,
    mode: "service-principal" | "on-behalf-of-user" = "service-principal",
  ): Promise<void> {
    if (mode === "on-behalf-of-user") {
      // OBO read cache is disabled — nothing to invalidate. Skipping here
      // also prevents accidentally caching a wrong-namespace delete that
      // would mask the missing cross-user invalidation if the cache were
      // ever re-enabled.
      return;
    }
    const parent = parentDirectory(writtenPath);
    const userKey = getCurrentUserId();
    const tryDelete = async (segment: string): Promise<void> => {
      try {
        await this.cache.delete(
          this.cache.generateKey([`files:${volumeKey}:list`, segment], userKey),
        );
      } catch (err) {
        logger.debug(
          "List-cache invalidation failed for volume=%s segment=%s: %O",
          volumeKey,
          segment,
          err,
        );
      }
    };

    // Compute the UC volume root (e.g. `"/Volumes/c/s/v"`) when the
    // connector has a default volume. Used both to detect absolute-path
    // root-level writes and to invalidate every cache key shape that
    // mapped to the volume root listing. `resolvePath("")` returns
    // `"<defaultVolume>/"`; strip the trailing slash for comparison.
    let volumeRoot: string | null = null;
    try {
      volumeRoot = connector.resolvePath("").replace(/\/+$/, "");
    } catch (err) {
      logger.debug(
        'List-cache invalidation: resolvePath("") failed for volume=%s: %O',
        volumeKey,
        err,
      );
    }

    // Root-level when the parent is empty/`"/"` (relative or `/foo.txt`)
    // OR when the parent equals the UC volume root (absolute UC path
    // `"/Volumes/c/s/v/foo.txt"`).
    const isRootLevel =
      !parent ||
      parent === "/" ||
      (volumeRoot !== null && parent === volumeRoot);

    if (isRootLevel) {
      // A rootless `list()` cached under `"__root__"`. Listings via
      // `?path=<volumeRoot>` or `?path=<volumeRoot>/` cached under the
      // volume path with/without trailing slash. Invalidate every shape.
      await tryDelete("__root__");
      if (volumeRoot !== null) {
        await tryDelete(volumeRoot);
        await tryDelete(`${volumeRoot}/`);
      }
      return;
    }

    let resolved: string;
    try {
      resolved = connector.resolvePath(parent);
    } catch (err) {
      logger.debug(
        "List-cache invalidation: resolvePath(%s) failed for volume=%s: %O",
        parent,
        volumeKey,
        err,
      );
      return;
    }
    await tryDelete(resolved);
  }

  private _handleApiError(
    res: express.Response,
    error: unknown,
    fallbackMessage: string,
  ): void {
    if (error instanceof PolicyDeniedError) {
      res.status(403).json({
        error: error.message,
        plugin: this.name,
      });
      return;
    }
    if (error instanceof AuthenticationError) {
      logger.warn("Authentication failed in %s: %O", this.name, error);
      res.status(401).json({ error: "Unauthorized", plugin: this.name });
      return;
    }
    if (error instanceof ApiError) {
      const status = error.statusCode ?? 500;
      if (status >= 400 && status < 500) {
        // Don't reflect raw SDK error.message — it can leak internal volume
        // paths, hostnames, or principal names. Use the standard HTTP status
        // text for the public body and log the full error server-side.
        logger.warn("Upstream %d in %s: %O", status, this.name, error);
        res.status(status).json({
          error: STATUS_CODES[status] ?? "Client Error",
          statusCode: status,
          plugin: this.name,
        });
        return;
      }
      logger.error("Upstream server error in %s: %O", this.name, error);
      res.status(500).json({ error: fallbackMessage, plugin: this.name });
      return;
    }
    logger.error("Unhandled error in %s: %O", this.name, error);
    res.status(500).json({ error: fallbackMessage, plugin: this.name });
  }

  private _sendStatusError(res: express.Response, status: number): void {
    res.status(status).json({
      error: STATUS_CODES[status] ?? "Unknown Error",
      plugin: this.name,
    });
  }

  private async _handleList(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const query = this._readPathQuery(req, res);
    if (!query) return;
    const path = query.path;

    if (!(await this._enforcePolicy(req, res, volumeKey, "list", path ?? "/")))
      return;

    const { mode, userCtx } = this._resolveAuthForRequest(req, volumeKey);
    await this._runWithAuth(userCtx, async () => {
      try {
        const result = await this.execute(
          async () => connector.list(getWorkspaceClient(), path),
          this._readSettings(
            [
              `files:${volumeKey}:list`,
              path ? connector.resolvePath(path) : "__root__",
            ],
            mode,
          ),
        );

        if (!result.ok) {
          this._sendStatusError(res, result.status);
          return;
        }
        res.json(result.data);
      } catch (error) {
        this._handleApiError(res, error, "List failed");
      }
    });
  }

  private async _handleRead(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const query = this._readPathQuery(req, res);
    if (!query) return;
    const rawPath = query.path;

    const valid = this._isValidPath(rawPath);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }
    const path = rawPath as string;

    if (!(await this._enforcePolicy(req, res, volumeKey, "read", path))) return;

    const volumeCfg = this.volumeConfigs[volumeKey];
    const maxReadSize = volumeCfg.maxReadSize ?? FILES_MAX_READ_SIZE;
    const { mode, userCtx } = this._resolveAuthForRequest(req, volumeKey);

    await this._runWithAuth(userCtx, async () => {
      try {
        // Drain the file body into a memory buffer capped at `maxReadSize`.
        // `/read` is for small text reads — clients wanting large or
        // streaming bodies use `/download` or `/raw`. Buffering preserves
        // the all-or-nothing contract: if the file exceeds the cap we
        // respond 413 atomically without leaking a partial 200 body.
        // Uses download-tier settings (no cache) — `/read` no longer
        // participates in the read-tier cache. Programmatic callers wanting
        // a cached small-file read should use the SDK
        // `volume.read(path, { maxSize })` method directly.
        const response = await this.execute(
          async () => connector.download(getWorkspaceClient(), path),
          this._downloadSettings(mode),
        );
        if (!response.ok) {
          this._sendStatusError(res, response.status);
          return;
        }
        if (!response.data.contents) {
          res.type("text/plain").send("");
          return;
        }

        const reader = response.data.contents.getReader();
        const chunks: Uint8Array[] = [];
        let bytesRead = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bytesRead += value.byteLength;
            if (bytesRead > maxReadSize) {
              res.status(413).json({
                error: `File exceeds maxReadSize (${maxReadSize} bytes). Use /download for large files.`,
                plugin: this.name,
              });
              try {
                await reader.cancel();
              } catch {
                // best-effort cleanup
              }
              return;
            }
            chunks.push(value);
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // best-effort cleanup
          }
        }

        res.type("text/plain").send(Buffer.concat(chunks, bytesRead));
      } catch (error) {
        this._handleApiError(res, error, "Read failed");
      }
    });
  }

  private async _handleDownload(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    return this._serveFile(req, res, connector, volumeKey, {
      mode: "download",
    });
  }

  private async _handleRaw(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    return this._serveFile(req, res, connector, volumeKey, {
      mode: "raw",
    });
  }

  /**
   * Shared handler for `/download` and `/raw` endpoints.
   * - `download`: always forces `Content-Disposition: attachment`.
   * - `raw`: adds CSP sandbox; forces attachment only for unsafe content types.
   */
  private async _serveFile(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
    opts: { mode: "download" | "raw" },
  ): Promise<void> {
    const query = this._readPathQuery(req, res);
    if (!query) return;
    const rawPath = query.path;

    const valid = this._isValidPath(rawPath);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }
    const path = rawPath as string;

    if (!(await this._enforcePolicy(req, res, volumeKey, opts.mode, path)))
      return;

    const label = opts.mode === "download" ? "Download" : "Raw fetch";
    const volumeCfg = this.volumeConfigs[volumeKey];
    const { mode, userCtx } = this._resolveAuthForRequest(req, volumeKey);

    await this._runWithAuth(userCtx, async () => {
      try {
        const settings = this._downloadSettings(mode);
        const response = await this.execute(
          async () => connector.download(getWorkspaceClient(), path),
          settings,
        );

        if (!response.ok) {
          this._sendStatusError(res, response.status);
          return;
        }

        const resolvedType = contentTypeFromPath(
          path,
          undefined,
          volumeCfg.customContentTypes,
        );
        const fileName = sanitizeFilename(path.split("/").pop() ?? "download");

        res.setHeader("Content-Type", resolvedType);
        res.setHeader("X-Content-Type-Options", "nosniff");

        if (opts.mode === "raw") {
          res.setHeader("Content-Security-Policy", "sandbox");
          if (!isSafeInlineContentType(resolvedType)) {
            res.setHeader(
              "Content-Disposition",
              `attachment; filename="${fileName}"`,
            );
          }
        } else {
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${fileName}"`,
          );
        }

        if (response.data.contents) {
          const nodeStream = Readable.fromWeb(
            response.data.contents as import("node:stream/web").ReadableStream,
          );
          nodeStream.on("error", (err) => {
            logger.error("Stream error during %s: %O", opts.mode, err);
            if (!res.headersSent) {
              this._sendStatusError(res, 500);
            } else {
              res.destroy();
            }
          });
          nodeStream.pipe(res);
        } else {
          res.end();
        }
      } catch (error) {
        this._handleApiError(res, error, `${label} failed`);
      }
    });
  }

  private async _handleExists(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const query = this._readPathQuery(req, res);
    if (!query) return;
    const rawPath = query.path;

    const valid = this._isValidPath(rawPath);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }
    const path = rawPath as string;

    if (!(await this._enforcePolicy(req, res, volumeKey, "exists", path)))
      return;

    const { mode, userCtx } = this._resolveAuthForRequest(req, volumeKey);
    await this._runWithAuth(userCtx, async () => {
      try {
        const result = await this.execute(
          async () => connector.exists(getWorkspaceClient(), path),
          this._readSettings(
            [`files:${volumeKey}:exists`, connector.resolvePath(path)],
            mode,
          ),
        );

        if (!result.ok) {
          this._sendStatusError(res, result.status);
          return;
        }
        res.json({ exists: result.data });
      } catch (error) {
        this._handleApiError(res, error, "Exists check failed");
      }
    });
  }

  private async _handleMetadata(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const query = this._readPathQuery(req, res);
    if (!query) return;
    const rawPath = query.path;

    const valid = this._isValidPath(rawPath);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }
    const path = rawPath as string;

    if (!(await this._enforcePolicy(req, res, volumeKey, "metadata", path)))
      return;

    const { mode, userCtx } = this._resolveAuthForRequest(req, volumeKey);
    await this._runWithAuth(userCtx, async () => {
      try {
        const result = await this.execute(
          async () => connector.metadata(getWorkspaceClient(), path),
          this._readSettings(
            [`files:${volumeKey}:metadata`, connector.resolvePath(path)],
            mode,
          ),
        );

        if (!result.ok) {
          this._sendStatusError(res, result.status);
          return;
        }
        res.json(result.data);
      } catch (error) {
        this._handleApiError(res, error, "Metadata fetch failed");
      }
    });
  }

  private async _handlePreview(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const query = this._readPathQuery(req, res);
    if (!query) return;
    const rawPath = query.path;

    const valid = this._isValidPath(rawPath);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }
    const path = rawPath as string;

    if (!(await this._enforcePolicy(req, res, volumeKey, "preview", path)))
      return;

    const { mode, userCtx } = this._resolveAuthForRequest(req, volumeKey);
    await this._runWithAuth(userCtx, async () => {
      try {
        const result = await this.execute(
          async () => connector.preview(getWorkspaceClient(), path),
          this._readSettings(
            [`files:${volumeKey}:preview`, connector.resolvePath(path)],
            mode,
          ),
        );

        if (!result.ok) {
          this._sendStatusError(res, result.status);
          return;
        }
        res.json(result.data);
      } catch (error) {
        this._handleApiError(res, error, "Preview failed");
      }
    });
  }

  private async _handleUpload(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const query = this._readPathQuery(req, res);
    if (!query) return;
    const rawPath = query.path;
    const valid = this._isValidPath(rawPath);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }
    const path = rawPath as string;

    const volumeCfg = this.volumeConfigs[volumeKey];
    const maxSize = volumeCfg.maxUploadSize ?? FILES_MAX_UPLOAD_SIZE;
    const rawContentLength = req.headers["content-length"];
    let contentLength: number | undefined;

    if (typeof rawContentLength === "string" && rawContentLength.length > 0) {
      if (!/^\d+$/.test(rawContentLength)) {
        res.status(400).json({
          error: "Invalid Content-Length header.",
          plugin: this.name,
        });
        return;
      }
      contentLength = Number(rawContentLength);
    }

    if (
      !(await this._enforcePolicy(req, res, volumeKey, "upload", path, {
        size: contentLength,
      }))
    )
      return;

    if (contentLength !== undefined && contentLength > maxSize) {
      res.status(413).json({
        error: `File size (${contentLength} bytes) exceeds maximum allowed size (${maxSize} bytes).`,
        plugin: this.name,
      });
      return;
    }

    logger.debug(req, "Upload started: volume=%s path=%s", volumeKey, path);

    const { mode, userCtx } = this._resolveAuthForRequest(req, volumeKey);
    await this._runWithAuth(userCtx, async () => {
      try {
        const rawStream: ReadableStream<Uint8Array> = Readable.toWeb(req);

        let bytesReceived = 0;
        const webStream = rawStream.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytesReceived += chunk.byteLength;
              if (bytesReceived > maxSize) {
                controller.error(
                  new Error(
                    `Upload stream exceeds maximum allowed size (${maxSize} bytes)`,
                  ),
                );
                return;
              }
              // When the client declared a Content-Length, the policy was
              // gated on that value (lines above pass `size: contentLength`
              // to `_enforcePolicy`). Refuse bytes beyond the declared size
              // so an attacker cannot bypass a per-user policy by sending a
              // small Content-Length and then streaming up to maxSize.
              if (
                contentLength !== undefined &&
                bytesReceived > contentLength
              ) {
                controller.error(
                  new Error(
                    `Upload stream exceeds declared Content-Length (${contentLength} bytes)`,
                  ),
                );
                return;
              }
              controller.enqueue(chunk);
            },
          }),
        );

        logger.debug(
          req,
          "Upload body received: volume=%s path=%s, size=%d bytes",
          volumeKey,
          path,
          contentLength ?? 0,
        );
        const settings = this._writeSettings(mode);
        // The connector's `upload` resolves `getWorkspaceClient()` and
        // `client.config.authenticate(headers)` synchronously inside this
        // callback. When `_runWithAuth` wraps us in `runInUserContext`, that
        // chain produces user-token Authorization headers on the outgoing
        // `fetch PUT`. The OBO upload-headers test pins this contract.
        const result = await this.trackWrite(() =>
          this.execute(async () => {
            await connector.upload(getWorkspaceClient(), path, webStream);
            return { success: true as const };
          }, settings),
        );

        // Awaited before sending the response so that a follow-up
        // `GET /list` issued in the same tick cannot race the
        // underlying `cache.delete()` and observe pre-write data.
        await this._invalidateListCache(volumeKey, path, connector, mode);

        if (!result.ok) {
          logger.error(
            req,
            "Upload failed: volume=%s path=%s, size=%d bytes",
            volumeKey,
            path,
            contentLength ?? 0,
          );
          this._sendStatusError(res, result.status);
          return;
        }

        logger.debug(
          req,
          "Upload complete: volume=%s path=%s",
          volumeKey,
          path,
        );
        res.json(result.data);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes("exceeds maximum allowed size") ||
            error.message.includes("exceeds declared Content-Length"))
        ) {
          res.status(413).json({ error: error.message, plugin: this.name });
          return;
        }
        this._handleApiError(res, error, "Upload failed");
      }
    });
  }

  private async _handleMkdir(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const dirPath =
      typeof req.body?.path === "string" ? req.body.path : undefined;

    const valid = this._isValidPath(dirPath);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }

    if (!(await this._enforcePolicy(req, res, volumeKey, "mkdir", dirPath)))
      return;

    const { mode, userCtx } = this._resolveAuthForRequest(req, volumeKey);
    await this._runWithAuth(userCtx, async () => {
      try {
        const settings = this._writeSettings(mode);
        const result = await this.trackWrite(() =>
          this.execute(async () => {
            await connector.createDirectory(getWorkspaceClient(), dirPath);
            return { success: true as const };
          }, settings),
        );

        // Awaited before sending the response so that a follow-up
        // `GET /list` issued in the same tick cannot race the
        // underlying `cache.delete()` and observe pre-write data.
        await this._invalidateListCache(volumeKey, dirPath, connector, mode);

        if (!result.ok) {
          this._sendStatusError(res, result.status);
          return;
        }

        res.json(result.data);
      } catch (error) {
        this._handleApiError(res, error, "Create directory failed");
      }
    });
  }

  private async _handleDelete(
    req: express.Request,
    res: express.Response,
    connector: FilesConnector,
    volumeKey: string,
  ): Promise<void> {
    const query = this._readPathQuery(req, res);
    if (!query) return;
    const rawPath = query.path;

    const valid = this._isValidPath(rawPath);
    if (valid !== true) {
      res.status(400).json({ error: valid, plugin: this.name });
      return;
    }
    const path = rawPath as string;

    if (!(await this._enforcePolicy(req, res, volumeKey, "delete", path)))
      return;

    const { mode, userCtx } = this._resolveAuthForRequest(req, volumeKey);
    await this._runWithAuth(userCtx, async () => {
      try {
        const settings = this._writeSettings(mode);
        const result = await this.trackWrite(() =>
          this.execute(async () => {
            await connector.delete(getWorkspaceClient(), path);
            return { success: true as const };
          }, settings),
        );

        // Awaited before sending the response so that a follow-up
        // `GET /list` issued in the same tick cannot race the
        // underlying `cache.delete()` and observe pre-write data.
        await this._invalidateListCache(volumeKey, path, connector, mode);

        if (!result.ok) {
          this._sendStatusError(res, result.status);
          return;
        }

        res.json(result.data);
      } catch (error) {
        this._handleApiError(res, error, "Delete failed");
      }
    });
  }

  private _resolveAuth(
    volumeKey: string,
  ): "service-principal" | "on-behalf-of-user" {
    return (
      this.volumeConfigs[volumeKey]?.auth ??
      this.config.auth ??
      "service-principal"
    );
  }

  /**
   * Build a `UserContext` from request headers when both
   * `x-forwarded-access-token` and `x-forwarded-user` are present, otherwise
   * return `null`. Used by OBO route handlers to wrap SDK calls in the
   * end-user's identity. A `null` result means "fall back to the service
   * principal client" — for OBO volumes in production, `_enforcePolicy` will
   * already have responded 401 before we get here, so `null` is reachable
   * only on the dev-fallback path.
   */
  private _buildUserContextOrNull(req: express.Request): UserContext | null {
    const token = req.header("x-forwarded-access-token")?.trim();
    const userId = req.header("x-forwarded-user")?.trim();
    if (!token || !userId) return null;
    return ServiceContext.createUserContext(token, userId);
  }

  /**
   * Build the telemetry attribute hash for the `files.auth_mode` span
   * attribute. The value reflects what operationally happened — i.e.
   * whether `runInUserContext` actually wrapped the SDK call:
   * - HTTP route on OBO volume + valid token → `"on-behalf-of-user"`.
   * - HTTP route on OBO volume + dev-fallback (no token) →
   *   `"service-principal"` (the route falls through to the SP client).
   * - HTTP route on SP volume → `"service-principal"`.
   * - `asUser(req)` programmatic calls with a real user context →
   *   `"on-behalf-of-user"`.
   * - Any unwrapped path → `"service-principal"`.
   */
  private _authModeAttributes(
    authMode: "service-principal" | "on-behalf-of-user",
  ): { "files.auth_mode": string } {
    return { "files.auth_mode": authMode };
  }

  /**
   * One-shot resolver for HTTP route handlers. Builds the request's
   * `UserContext` AT MOST ONCE (when the volume is OBO and the headers are
   * present) and returns both the operationally-effective auth mode and the
   * pre-built `UserContext`.
   *
   * Handlers thread the `userCtx` into `_runWithAuth(userCtx, fn)` to avoid
   * a second `ServiceContext.createUserContext()` allocation — that call
   * builds a fresh `WorkspaceClient` per invocation, so doing it twice per
   * request was pure throwaway overhead.
   */
  private _resolveAuthForRequest(
    req: express.Request,
    volumeKey: string,
  ): {
    mode: "service-principal" | "on-behalf-of-user";
    userCtx: UserContext | null;
  } {
    if (this._resolveAuth(volumeKey) !== "on-behalf-of-user") {
      return { mode: "service-principal", userCtx: null };
    }
    const userCtx = this._buildUserContextOrNull(req);
    return userCtx
      ? { mode: "on-behalf-of-user", userCtx }
      : { mode: "service-principal", userCtx: null };
  }

  /**
   * Run `fn` under the correct execution context.
   * - `userCtx` is `null`: invokes `fn` directly so the service-principal
   *   `WorkspaceClient` and `getCurrentUserId()` are used — identical
   *   behavior to pre-OBO releases. This covers both SP volumes and the
   *   OBO dev-fallback path (where headers were missing).
   * - `userCtx` is a `UserContext`: wraps `fn` in `runInUserContext(userCtx)`,
   *   so SDK calls execute as the end user and `getCurrentUserId()` (and
   *   therefore cache keys) resolve to the user's ID.
   *
   * The caller is responsible for building `userCtx` exactly once per
   * request via `_resolveAuthForRequest`; this signature deliberately does
   * NOT take a `req` so it cannot accidentally re-build the context.
   */
  private async _runWithAuth(
    userCtx: UserContext | null,
    fn: () => Promise<void>,
  ): Promise<void> {
    if (userCtx) {
      return runInUserContext(userCtx, fn);
    }
    return fn();
  }

  /**
   * Tag the span that `FilesConnector.<operation>` opens with
   * `files.auth_mode`. Programmatic VolumeAPI methods bypass
   * `this.execute(...)` (and therefore the `TelemetryInterceptor`), so the
   * connector's own `files.<operation>` span is the natural place to land
   * this attribute. Rather than opening a parent `files.<operation>` span
   * (which would duplicate the connector's span — same name, doubled
   * allocation/export), we propagate the attribute via AsyncLocalStorage
   * and let the connector merge it into its existing span at creation
   * time.
   *
   * The `operation` parameter is unused by the propagation mechanism (the
   * connector knows its own operation), but kept in the signature for API
   * stability with the previous span-creation form.
   */
  private _withAuthModeAttributes<R>(
    _operation: string,
    authMode: "service-principal" | "on-behalf-of-user",
    fn: () => Promise<R>,
  ): Promise<R> {
    return runWithFilesSpanAttributes(this._authModeAttributes(authMode), fn);
  }

  /**
   * Wrap each `VolumeAPI` method so the `FilesConnector` span it produces is
   * tagged with `files.auth_mode = "service-principal"`. Used for
   * programmatic calls that don't go through `asUser(req)`.
   *
   * The attribute is attached to the connector's existing span via
   * AsyncLocalStorage propagation (see `_withAuthModeAttributes`); no
   * additional parent span is opened, so each call produces exactly one
   * `files.<operation>` span instead of two.
   */
  private _wrapVolumeAPIWithSPSpan(api: VolumeAPI): VolumeAPI {
    const wrap =
      <Args extends unknown[], R>(
        operation: string,
        fn: (...args: Args) => Promise<R>,
      ): ((...args: Args) => Promise<R>) =>
      (...args: Args) =>
        this._withAuthModeAttributes(operation, "service-principal", () =>
          fn(...args),
        );

    return {
      list: wrap("list", api.list),
      read: wrap("read", api.read),
      download: wrap("download", api.download),
      exists: wrap("exists", api.exists),
      metadata: wrap("metadata", api.metadata),
      upload: wrap("upload", api.upload),
      createDirectory: wrap("createDirectory", api.createDirectory),
      delete: wrap("delete", api.delete),
      preview: wrap("preview", api.preview),
    };
  }

  /**
   * Wrap each `VolumeAPI` method so its execution runs inside
   * `runInUserContext(userCtx, ...)`. Used by `VolumeHandle.asUser(req)` to
   * force the SDK identity to the end user regardless of the volume's
   * `auth` setting. The policy check baked into each method (via
   * `createVolumeAPI`) runs inside the same scope, so `getCurrentUserId()`
   * and any cache `userKey` derived from it also resolve to the user.
   *
   * Each wrapped invocation tags the connector's span with
   * `files.auth_mode = "on-behalf-of-user"` via AsyncLocalStorage
   * propagation — no additional parent span is opened.
   */
  private _wrapVolumeAPIInUserContext(
    api: VolumeAPI,
    userCtx: UserContext,
  ): VolumeAPI {
    const wrap =
      <Args extends unknown[], R>(
        operation: string,
        fn: (...args: Args) => Promise<R>,
      ): ((...args: Args) => Promise<R>) =>
      (...args: Args) =>
        this._withAuthModeAttributes(operation, "on-behalf-of-user", () =>
          runInUserContext(userCtx, () => fn(...args)),
        );

    return {
      list: wrap("list", api.list),
      read: wrap("read", api.read),
      download: wrap("download", api.download),
      exists: wrap("exists", api.exists),
      metadata: wrap("metadata", api.metadata),
      upload: wrap("upload", api.upload),
      createDirectory: wrap("createDirectory", api.createDirectory),
      delete: wrap("delete", api.delete),
      preview: wrap("preview", api.preview),
    };
  }

  /**
   * Creates a VolumeAPI for a specific volume key.
   *
   * Enforces the volume's policy before each operation.
   */
  protected createVolumeAPI(
    volumeKey: string,
    user: FilePolicyUser,
  ): VolumeAPI {
    const connector = this.volumeConnectors[volumeKey];
    const check = (
      action: FileAction,
      path: string,
      overrides?: Partial<FileResource>,
    ) => this._checkPolicy(volumeKey, action, path, user, overrides);

    return {
      list: async (directoryPath?: string) => {
        await check("list", directoryPath ?? "/");
        return connector.list(getWorkspaceClient(), directoryPath);
      },
      read: async (filePath: string, opts?: { maxSize?: number }) => {
        await check("read", filePath);
        return connector.read(getWorkspaceClient(), filePath, opts);
      },
      download: async (filePath: string) => {
        await check("download", filePath);
        return connector.download(getWorkspaceClient(), filePath);
      },
      exists: async (filePath: string) => {
        await check("exists", filePath);
        return connector.exists(getWorkspaceClient(), filePath);
      },
      metadata: async (filePath: string) => {
        await check("metadata", filePath);
        return connector.metadata(getWorkspaceClient(), filePath);
      },
      upload: async (
        filePath: string,
        contents: ReadableStream | Buffer | string,
        opts?: { overwrite?: boolean },
      ) => {
        await check("upload", filePath);
        return connector.upload(getWorkspaceClient(), filePath, contents, opts);
      },
      createDirectory: async (directoryPath: string) => {
        await check("mkdir", directoryPath);
        return connector.createDirectory(getWorkspaceClient(), directoryPath);
      },
      delete: async (filePath: string) => {
        await check("delete", filePath);
        return connector.delete(getWorkspaceClient(), filePath);
      },
      preview: async (filePath: string) => {
        await check("preview", filePath);
        return connector.preview(getWorkspaceClient(), filePath);
      },
    };
  }

  /**
   * Builds the agent-tool registry entries for a single volume. One set of
   * tools per configured volume, keyed by `${volumeKey}.${method}`.
   *
   * Each handler resolves the caller's identity from the current execution
   * context (OBO user when the agent run is wrapped in `asUser(req)`, service
   * principal otherwise in local dev) and dispatches through
   * `createVolumeAPI(volumeKey, user)` so the volume's policy is enforced
   * uniformly for agent and HTTP callers.
   */
  private _defineVolumeTools(volumeKey: string): ToolRegistry {
    const buildUser = (): FilePolicyUser => {
      const ctx = getExecutionContext();
      return isUserContext(ctx)
        ? { id: ctx.userId }
        : { id: ctx.serviceUserId, isServicePrincipal: true };
    };
    const api = () => this.createVolumeAPI(volumeKey, buildUser());
    return {
      [`${volumeKey}.list`]: defineTool({
        description: `List files and directories in the "${volumeKey}" volume`,
        schema: z.object({
          path: z
            .string()
            .optional()
            .describe("Directory path to list (optional, defaults to root)"),
        }),
        annotations: { effect: "read", requiresUserContext: true },
        autoInheritable: true,
        execute: (args, signal) => {
          signal?.throwIfAborted();
          return api().list(args.path);
        },
      }),
      [`${volumeKey}.read`]: defineTool({
        description: `Read a text file from the "${volumeKey}" volume`,
        schema: z.object({
          path: z.string().describe("File path to read"),
        }),
        annotations: { effect: "read", requiresUserContext: true },
        autoInheritable: true,
        execute: (args, signal) => {
          signal?.throwIfAborted();
          return api().read(args.path);
        },
      }),
      [`${volumeKey}.exists`]: defineTool({
        description: `Check if a file or directory exists in the "${volumeKey}" volume`,
        schema: z.object({
          path: z.string().describe("Path to check"),
        }),
        annotations: { effect: "read", requiresUserContext: true },
        autoInheritable: true,
        execute: (args, signal) => {
          signal?.throwIfAborted();
          return api().exists(args.path);
        },
      }),
      [`${volumeKey}.metadata`]: defineTool({
        description: `Get metadata (size, type, last modified) for a file in the "${volumeKey}" volume`,
        schema: z.object({
          path: z.string().describe("File path"),
        }),
        annotations: { effect: "read", requiresUserContext: true },
        autoInheritable: true,
        execute: (args, signal) => {
          signal?.throwIfAborted();
          return api().metadata(args.path);
        },
      }),
      [`${volumeKey}.upload`]: defineTool({
        description: `Upload a text file to the "${volumeKey}" volume`,
        schema: z.object({
          path: z.string().describe("Destination file path"),
          contents: z.string().describe("File contents as a string"),
          overwrite: z
            .boolean()
            .optional()
            .describe("Whether to overwrite existing file"),
        }),
        annotations: { effect: "destructive", requiresUserContext: true },
        execute: (args, signal) => {
          signal?.throwIfAborted();
          return api().upload(args.path, args.contents, {
            overwrite: args.overwrite,
          });
        },
      }),
      [`${volumeKey}.delete`]: defineTool({
        description: `Delete a file from the "${volumeKey}" volume`,
        schema: z.object({
          path: z.string().describe("File path to delete"),
        }),
        annotations: { effect: "destructive", requiresUserContext: true },
        execute: (args, signal) => {
          signal?.throwIfAborted();
          return api().delete(args.path);
        },
      }),
    };
  }

  private inflightWrites = 0;

  private trackWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.inflightWrites++;
    return fn().finally(() => {
      this.inflightWrites--;
    });
  }

  async shutdown(): Promise<void> {
    // Wait up to 10 seconds for in-flight write operations to finish
    const deadline = Date.now() + 10_000;
    while (this.inflightWrites > 0 && Date.now() < deadline) {
      logger.info(
        "Waiting for %d in-flight write(s) to complete before shutdown…",
        this.inflightWrites,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (this.inflightWrites > 0) {
      logger.warn(
        "Shutdown deadline reached with %d in-flight write(s) still pending.",
        this.inflightWrites,
      );
    }
    this.streamManager.abortAll();
  }

  getAgentTools(): AgentToolDefinition[] {
    return toolsFromRegistry(this.tools);
  }

  async executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return executeFromRegistry(this.tools, name, args, signal);
  }

  toolkit(opts?: import("../../core/agent/types").ToolkitOptions) {
    return buildToolkitEntries(this.name, this.tools, opts);
  }

  /**
   * Returns the programmatic API for the Files plugin.
   * Callable with a volume key to get a volume-scoped handle.
   *
   * SP volumes (`auth: "service-principal"`, the default) execute as the
   * service principal. OBO volumes (`auth: "on-behalf-of-user"`) executed
   * through the HTTP routes run as the end user; for programmatic calls
   * outside a route, use `asUser(req)` to opt into per-user execution.
   * `asUser(req)` is a hard override at the SDK level: it forces every
   * subsequent call to execute as the end user inside `runInUserContext`,
   * regardless of the volume's `auth` setting. Policies control per-user
   * access in either mode.
   *
   * @example
   * ```ts
   * // Service principal access
   * appKit.files("uploads").list()
   *
   * // With policy: pass user identity for access control. The SDK call
   * // also executes as the user (not the service principal).
   * appKit.files("uploads").asUser(req).list()
   * ```
   */
  exports(): FilesExport {
    const resolveVolume = (volumeKey: string): VolumeHandle => {
      if (!this.volumeKeys.includes(volumeKey)) {
        throw new Error(
          `Unknown volume "${volumeKey}". Available volumes: ${this.volumeKeys.join(", ")}`,
        );
      }

      // Lazy user resolution: getCurrentUserId() is called when a method
      // is invoked (policy check), not when exports() is called.
      const spUser: FilePolicyUser = {
        get id() {
          return getCurrentUserId();
        },
        isServicePrincipal: true,
      };
      // Default (non-asUser) programmatic surface: every call is tagged
      // with `files.auth_mode = "service-principal"` for telemetry parity
      // with the HTTP route path.
      const spApi = this._wrapVolumeAPIWithSPSpan(
        this.createVolumeAPI(volumeKey, spUser),
      );

      return {
        ...spApi,
        asUser: (req: express.Request) => {
          const user = this._extractUser(req);
          const api = this.createVolumeAPI(volumeKey, user);
          // Force OBO at the SDK level regardless of the volume's `auth`
          // setting: each method runs inside `runInUserContext` so
          // `getWorkspaceClient()` returns the user-token client. When no
          // user token is available (only reachable in dev mode after the
          // strict `_extractUser` falls back to the SP identity), we skip
          // the OBO wrap and instead apply the SP-mode span wrap so trace
          // output reflects the actual SP execution.
          const userCtx = this._buildUserContextOrNull(req);
          if (!userCtx) return this._wrapVolumeAPIWithSPSpan(api);
          return this._wrapVolumeAPIInUserContext(api, userCtx);
        },
      };
    };

    const filesExport = ((volumeKey: string) =>
      resolveVolume(volumeKey)) as FilesExport;
    filesExport.volume = resolveVolume;

    return filesExport;
  }

  clientConfig(): Record<string, unknown> {
    return { volumes: this.volumeKeys };
  }
}

/**
 * @internal
 */
export const files = Object.assign(toPlugin(FilesPlugin), { policy });
