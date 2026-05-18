---
sidebar_position: 6
---

# Files plugin

File operations against Databricks Unity Catalog Volumes. Supports listing, reading, downloading, uploading, deleting, and previewing files with built-in caching, retry, and timeout handling via the execution interceptor pipeline.

**Key features:**
- **Multi-volume**: Define named volumes (e.g. `uploads`, `exports`) and access them independently
- CRUD operations on Unity Catalog Volume files
- Streaming downloads with content-type resolution
- Inline raw serving with XSS-safe content type enforcement
- Upload size limits with streaming enforcement
- Automatic cache invalidation on write operations
- Custom content type mappings
- **Per-volume auth modes**: each volume can run as the service principal (the default) or on behalf of the end user
- **Access policies**: Per-volume policy functions that gate read and write operations

## Basic usage

```ts
import { createApp, files, server } from "@databricks/appkit";

await createApp({
  plugins: [
    server(),
    files(),
  ],
});
```

Set `DATABRICKS_VOLUME_*` environment variables in your `app.yaml` (or `.env`). The plugin auto-discovers them at startup:

```bash
DATABRICKS_VOLUME_UPLOADS=/Volumes/catalog/schema/uploads
DATABRICKS_VOLUME_EXPORTS=/Volumes/catalog/schema/exports
```

That's it — no `volumes` config needed. The env var suffix becomes the volume key (lowercased):

| Environment variable         | Volume key |
| ---------------------------- | ---------- |
| `DATABRICKS_VOLUME_UPLOADS`  | `uploads`  |
| `DATABRICKS_VOLUME_EXPORTS`  | `exports`  |

## Auto-discovery

The plugin scans `process.env` for keys matching `DATABRICKS_VOLUME_*` and registers each as a volume with default `{}` config. Env vars with an empty value or the bare `DATABRICKS_VOLUME_` prefix (no suffix) are skipped.

**Merge semantics:** auto-discovered volumes are always merged with explicitly configured ones. Explicit config wins for per-volume overrides (e.g., `maxUploadSize`), while discovered-only volumes get default settings.

```ts
// Explicit overrides for uploads; exports is auto-discovered from env
files({
  volumes: {
    uploads: { maxUploadSize: 100_000_000 },
  },
});
```

This produces two volumes (`uploads` with a 100 MB limit, `exports` with defaults), assuming both `DATABRICKS_VOLUME_UPLOADS` and `DATABRICKS_VOLUME_EXPORTS` are set.

## Configuration

```ts
interface IFilesConfig {
  /** Named volumes to expose. Each key becomes a volume accessor. */
  volumes?: Record<string, VolumeConfig>;
  /** Operation timeout in milliseconds. Overrides the per-tier defaults. */
  timeout?: number;
  /** Map of file extensions to MIME types (priority over built-in map). Inherited by all volumes. */
  customContentTypes?: Record<string, string>;
  /** Maximum upload size in bytes. Defaults to 5 GB. Inherited by all volumes. */
  maxUploadSize?: number;
  /**
   * Plugin-level default auth mode. Volumes inherit this when they do not
   * set `VolumeConfig.auth`. Defaults to `"service-principal"`.
   */
  auth?: "service-principal" | "on-behalf-of-user";
}

interface VolumeConfig {
  /** Access policy for this volume. */
  policy?: FilePolicy;
  /** Maximum upload size in bytes for this volume. Overrides plugin-level default. */
  maxUploadSize?: number;
  /** Map of file extensions to MIME types for this volume. Overrides plugin-level default. */
  customContentTypes?: Record<string, string>;
  /**
   * Per-volume auth mode. Inherits from `IFilesConfig.auth` when not set;
   * defaults to `"service-principal"`.
   */
  auth?: "service-principal" | "on-behalf-of-user";
}
```

### Per-volume overrides

Each volume inherits the plugin-level `maxUploadSize` and `customContentTypes` unless overridden:

```ts
files({
  maxUploadSize: 5_000_000_000, // 5 GB default for all volumes
  customContentTypes: { ".avro": "application/avro" },
  volumes: {
    uploads: { maxUploadSize: 100_000_000 }, // 100 MB limit for uploads only
    exports: {},                              // uses plugin-level defaults
  },
});
```

### Auth modes

Each volume runs in one of two auth modes. The mode determines which identity executes the underlying Unity Catalog SDK call — and therefore which UC grant applies:

| Mode | SDK identity | Required UC grant on the volume |
| --- | --- | --- |
| `"service-principal"` (default) | the app's service principal | `WRITE_VOLUME` (or read-equivalent) on the **SP** |
| `"on-behalf-of-user"` | the end user from the request | `WRITE_VOLUME` (or read-equivalent) on the **end user** |

#### Resolution order

For each volume the plugin resolves the auth mode in this order:

```
VolumeConfig.auth  >  IFilesConfig.auth  >  "service-principal"
```

Set `IFilesConfig.auth` to flip the default for every volume in one place, and override individual volumes via `VolumeConfig.auth`.

#### Service-principal mode (default)

Every HTTP request executes as the app's service principal. The end-user identity (from `x-forwarded-user`) is still passed into the volume policy, but the SDK call uses the SP's credentials:

```ts
files({
  volumes: {
    exports: {
      // auth is implicit: "service-principal"
      policy: files.policy.publicRead(),
    },
  },
});
```

Use SP mode for shared resources, app-managed exports, or any case where you want a single grant on the SP to govern all access.

#### On-behalf-of-user mode

Every HTTP request executes as the end user. The plugin pulls the user identity and access token from the headers Databricks Apps inject (`x-forwarded-user` and `x-forwarded-access-token`) and runs the SDK call inside `runInUserContext`:

```ts
files({
  volumes: {
    "user-uploads": {
      auth: "on-behalf-of-user",
      // The policy sees the real end user (isServicePrincipal: false).
      // You can use the volume policy in addition to UC grants.
      policy: (action, _resource, user) =>
        // Only allow real end users, never the SP.
        !user.isServicePrincipal,
    },
  },
});
```

Use OBO mode when the per-user UC grant is meaningful — e.g. enforcement of UC ACLs at the SDK layer, or audit trails that need to attribute the API call to the end user instead of the app's SP.

#### Production vs development behavior

| Environment | OBO request with **valid** token | OBO request with **missing** `x-forwarded-access-token` |
| --- | --- | --- |
| Production | Runs as the end user. | `401 Unauthorized` — no SDK call is made. |
| Development (`NODE_ENV === "development"`) | Runs as the end user. | Logs a warning, falls back to the SP, and continues. |

The dev-mode fallback exists so local testing without a Databricks Apps reverse proxy continues to work; deployed apps always have the headers injected.

#### Limitations

- The plugin manifest's `getResourceRequirements()` declares `WRITE_VOLUME` on the **service principal** for every volume, regardless of the volume's `auth` mode. For OBO volumes, the actual permission requirement is on the **end user** — communicate this out-of-band (deployment runbooks, customer onboarding docs) until the plugin manifest schema gains a per-volume auth scope field.
- OBO volumes disable the read/list cache entirely. The cache layer keys by `getCurrentUserId()`, so a write by user A wouldn't invalidate user B's view of the same path; rather than risk cross-user staleness, OBO traffic skips the cache and fetches fresh on every request. SP volumes still cache (single slice keyed by the SP id).

### Permission model

There are three layers of access control in the files plugin. Understanding how they interact is critical for securing your app:

```
┌─────────────────────────────────────────────────┐
│  Unity Catalog grants                           │
│  WRITE_VOLUME on the SP (auth: service-principal)│
│  WRITE_VOLUME on the user (auth: on-behalf-of-user)│
├─────────────────────────────────────────────────┤
│  Execution identity                             │
│  Resolved per volume from VolumeConfig.auth ??  │
│  IFilesConfig.auth ?? "service-principal".      │
│  asUser(req) is a hard override at the SDK     │
│  level for the programmatic API.                │
├─────────────────────────────────────────────────┤
│  File policies                                  │
│  Per-volume (action, resource, user) → boolean  │
│  Only app-level gate for HTTP routes            │
└─────────────────────────────────────────────────┘
```

- **UC grants** control what an identity can do at the Databricks level. Which identity needs the grant depends on the volume's auth mode (see [Auth modes](#auth-modes)). For SP volumes, the SP needs `WRITE_VOLUME` (the plugin declares this in its manifest). For OBO volumes, the **end user** needs `WRITE_VOLUME` on the volume; the SP itself does not.
- **Execution identity** determines whose credentials are used for the actual API call. Each volume resolves to either the service principal or the end user, per its `auth` setting. The programmatic API also exposes `asUser(req)` to force per-user execution regardless of the volume's `auth`.
- **File policies** are application-level checks evaluated **before** the API call. They receive a `FilePolicyUser` describing the caller and decide allow/deny. On HTTP routes the policy user is selected based on the volume's `auth` mode and the request headers — see the [`isServicePrincipal` matrix](#policy-user-matrix). On SP volumes when `x-forwarded-user` is absent, the policy receives `{ id: <sp-id>, isServicePrincipal: true }` and decides whether to allow service-principal traffic. This is the only gate that distinguishes between users on HTTP routes.

:::warning

For service-principal volumes, every HTTP request executes as the SP regardless of which user made it — so removing a user's UC `WRITE_VOLUME` grant has **no effect** on HTTP access. Policies are how you restrict what individual users can do through your app.

For on-behalf-of-user volumes, requests execute as the requesting user — so each user must have `WRITE_VOLUME` on the volume themselves, and you can rely on UC grants in addition to policies.

:::

:::info New in v0.21.0

File policies are new. Volumes without an explicit policy now default to `publicRead()`, which **denies all write operations** (`upload`, `mkdir`, `delete`). If your app relies on write access, set an explicit policy — for example `files.policy.allowAll()` — on each volume that needs it.

:::

#### Access policies

Attach a policy to a volume to control which actions are allowed:

```ts
import { files } from "@databricks/appkit";

files({
  volumes: {
    uploads: { policy: files.policy.publicRead() },
  },
});
```

#### Actions

Policies receive an action string. The full list, split by category:

| Category | Actions |
|----------|---------|
| Read | `list`, `read`, `download`, `raw`, `exists`, `metadata`, `preview` |
| Write | `upload`, `mkdir`, `delete` |

#### Built-in policies

| Helper | Allows | Denies |
|--------|--------|--------|
| `files.policy.publicRead()` | all read actions | all write actions |
| `files.policy.allowAll()` | everything | nothing |
| `files.policy.denyAll()` | nothing | everything |

#### Composing policies

Combine built-in and custom policies with three combinators:

- **`files.policy.all(a, b)`** — AND: all policies must allow. Short-circuits on first denial.
- **`files.policy.any(a, b)`** — OR: at least one policy must allow. Short-circuits on first allow.
- **`files.policy.not(p)`** — Inverts a policy. For example, `not(publicRead())` yields a write-only policy (useful for ingestion/drop-box volumes).

```ts
// Read-only for regular users, full access for the service principal
files({
  volumes: {
    shared: {
      policy: files.policy.any(
        (_action, _resource, user) => !!user.isServicePrincipal,
        files.policy.publicRead(),
      ),
    },
  },
});
```

#### Custom policies

`FilePolicy` is a function `(action, resource, user) → boolean | Promise<boolean>`, so you can inline arbitrary logic:

```ts
import { type FilePolicy, WRITE_ACTIONS } from "@databricks/appkit";

const ADMIN_IDS = ["admin-sp-id", "lead-user-id"];

const adminOnly: FilePolicy = (action, _resource, user) => {
  if (WRITE_ACTIONS.has(action)) {
    return ADMIN_IDS.includes(user.id);
  }
  return true; // reads allowed for everyone
};

files({
  volumes: { reports: { policy: adminOnly } },
});
```

#### OBO policy example

For on-behalf-of-user volumes, the policy receives `isServicePrincipal: false` whenever the request runs with a real end-user identity. A common pattern is to deny SP traffic outright so anonymous (header-less) calls can't reach the volume:

```ts
import { type FilePolicy } from "@databricks/appkit";

// Deny anything running as the service principal — including the dev-mode
// fallback when no x-forwarded-access-token was provided. Real end users
// (with isServicePrincipal: false) get the configured access.
const usersOnly: FilePolicy = (_action, _resource, user) => {
  return user.isServicePrincipal !== true;
};

files({
  volumes: {
    "user-uploads": {
      auth: "on-behalf-of-user",
      policy: usersOnly,
    },
  },
});
```

You can compose it with any other policy via `files.policy.all(...)` to add per-action gating:

```ts
files({
  volumes: {
    "user-uploads": {
      auth: "on-behalf-of-user",
      policy: files.policy.all(usersOnly, files.policy.publicRead()),
    },
  },
});
```

#### Policy user matrix

The plugin selects the policy user based on the volume's effective `auth` mode and the request headers. The full table:

| Volume `auth`         | Path                        | Headers                       | `isServicePrincipal` | Notes                                                                                          |
| --------------------- | --------------------------- | ----------------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `service-principal`   | HTTP                        | `x-forwarded-user` present    | `false` (or unset)   | Pre-OBO behavior. Policy sees the end user but the SDK call still runs as the SP.              |
| `service-principal`   | HTTP                        | no `x-forwarded-user`         | `true`               | Headerless request — policy and SDK both run as the SP.                                        |
| `on-behalf-of-user`   | HTTP                        | valid token + user header     | `false`              | Real end-user execution. Policy sees the user; the SDK call also runs as the user.             |
| `on-behalf-of-user`   | HTTP                        | missing token, dev-fallback   | `true`               | Only reachable when `NODE_ENV === "development"` (prod returns 401). Treated as SP traffic.    |
| any                   | Programmatic `asUser(req)`  | `x-forwarded-user` present    | `false`              | `asUser` extracts the user; the SDK call runs as the user inside `runInUserContext`.           |
| any                   | Programmatic (no `asUser`)  | n/a                           | `true`               | No request available to derive a user — runs as the SP.                                        |

#### Enforcement

- **HTTP routes**: Policy checked before every operation. Denied → `403` JSON response with `Policy denied "{action}" on volume "{volumeKey}"`.
- **Programmatic API**: Policy checked on both `appkit.files("vol").list()` (SP identity, `isServicePrincipal: true`) and `appkit.files("vol").asUser(req).list()` (user identity). Denied → throws `PolicyDeniedError`.
- **No policy configured**: Defaults to `files.policy.publicRead()` — read actions are allowed, write actions are denied. A startup warning is logged encouraging you to set an explicit policy.

### Custom content types

Override or extend the built-in extension → MIME map:

```ts
files({
  volumes: { data: {} },
  customContentTypes: {
    ".avro": "application/avro",
    ".ndjson": "application/x-ndjson",
  },
});
```

Dangerous MIME types (`text/html`, `text/javascript`, `application/javascript`, `application/xhtml+xml`, `image/svg+xml`) are blocked to prevent stored-XSS when files are served inline via `/raw`.

## HTTP routes

Routes are mounted at `/api/files/*`. Each route resolves the volume's [auth mode](#auth-modes) and either executes as the service principal (the default) or wraps the SDK call in `runInUserContext` for OBO volumes. Before every operation the volume policy runs against the resolved policy user — see the [policy user matrix](#policy-user-matrix) for the exact mapping. See also [Access policies](#access-policies).

| Method | Path                       | Query / Body                 | Response                                          |
| ------ | -------------------------- | ---------------------------- | ------------------------------------------------- |
| GET    | `/volumes`                 | —                            | `{ volumes: string[] }`                           |
| GET    | `/:volumeKey/list`         | `?path` (optional)           | `DirectoryEntry[]`                                |
| GET    | `/:volumeKey/read`         | `?path` (required)           | `text/plain` body                                 |
| GET    | `/:volumeKey/download`     | `?path` (required)           | Binary stream (`Content-Disposition: attachment`)  |
| GET    | `/:volumeKey/raw`          | `?path` (required)           | Binary stream (inline for safe types, attachment for unsafe) |
| GET    | `/:volumeKey/exists`       | `?path` (required)           | `{ exists: boolean }`                             |
| GET    | `/:volumeKey/metadata`     | `?path` (required)           | `FileMetadata`                                    |
| GET    | `/:volumeKey/preview`      | `?path` (required)           | `FilePreview`                                     |
| POST   | `/:volumeKey/upload`       | `?path` (required), raw body | `{ success: true }`                               |
| POST   | `/:volumeKey/mkdir`        | `body.path` (required)       | `{ success: true }`                               |
| DELETE | `/:volumeKey`              | `?path` (required)           | `{ success: true }`                               |

The `:volumeKey` parameter must match one of the configured volume keys. Unknown volume keys return a `404` with the list of available volumes.

### Path validation

All endpoints that accept a `path` parameter enforce:
- Path is required (non-empty)
- Maximum 4096 characters
- No null bytes

### Raw endpoint security

The `/:volumeKey/raw` endpoint serves files inline for browser display but applies security headers:
- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: sandbox`
- Unsafe content types (HTML, JS, SVG) are forced to download via `Content-Disposition: attachment`

## Execution defaults

Every operation runs through the interceptor pipeline with tier-specific defaults:

| Tier         | Cache | Retry | Timeout | Operations                            |
| ------------ | ----- | ----- | ------- | ------------------------------------- |
| **Read**     | 60 s  | 3x    | 30 s    | list, read, exists, metadata, preview |
| **Download** | none  | 3x    | 30 s    | download, raw                         |
| **Write**    | none  | none  | 600 s   | upload, mkdir, delete                 |

Retry uses exponential backoff with a 1 s initial delay.

The download timeout applies to the stream start, not the full transfer.

## Cache isolation

Cache keys include the volume key, ensuring volumes have independent caches. For example, `uploads:list` and `exports:list` are cached separately.

Write operations (`upload`, `mkdir`, `delete`) automatically invalidate the cached `list` entry for the parent directory of the affected volume.

## Programmatic API

The `files` plugin export is a callable that accepts a volume key and returns a `VolumeHandle`. The handle exposes all `VolumeAPI` methods directly and an `asUser(req)` method for opting into per-user execution.

```ts
// Default — runs as the service principal, regardless of the volume's auth
// setting (no req is available to derive a user from).
const entries = await appkit.files("uploads").list();

// asUser(req) — runs as the end user, regardless of the volume's auth
// setting. Forces SDK calls into runInUserContext using the request's
// x-forwarded-user / x-forwarded-access-token headers.
const entries = await appkit.files("uploads").asUser(req).list();
const content = await appkit.files("exports").asUser(req).read("report.csv");

// Named accessor
const vol = appkit.files.volume("uploads");
await vol.asUser(req).list();
```

### `asUser(req)`

`asUser(req)` is the supported path for programmatic per-user execution. The returned API runs every method inside `runInUserContext` so the underlying `WorkspaceClient` is the user-token client — the SDK call executes as the user, not just the policy check.

In production, `asUser(req)` throws `AuthenticationError.missingToken` when either `x-forwarded-user` or `x-forwarded-access-token` is absent — both headers are required to mint a user-scoped client. In development (`NODE_ENV === "development"`) it logs a warning and falls back to the service principal so local testing without a Databricks Apps reverse proxy keeps working — the fallback skips the `runInUserContext` wrap.

:::warning Programmatic OBO without `asUser(req)`

A volume configured with `auth: "on-behalf-of-user"` only routes through `runInUserContext` on the **HTTP route path**, where the request headers are available. A direct programmatic call — `appkit.files("obo-vol").list()` — has no request to derive an end-user identity from, so it executes against whatever client `getWorkspaceClient()` resolves to at the call site (typically the SP at the top level).

For programmatic per-user execution, always use `asUser(req)`. The volume's `auth` mode controls HTTP traffic; `asUser(req)` controls programmatic traffic.

:::

### VolumeAPI methods

| Method            | Signature                                                                                          | Returns            |
| ----------------- | -------------------------------------------------------------------------------------------------- | ------------------ |
| `list`            | `(directoryPath?: string)`                                                                         | `DirectoryEntry[]` |
| `read`            | `(filePath: string, options?: { maxSize?: number })`                                               | `string`           |
| `download`        | `(filePath: string)`                                                                               | `DownloadResponse` |
| `exists`          | `(filePath: string)`                                                                               | `boolean`          |
| `metadata`        | `(filePath: string)`                                                                               | `FileMetadata`     |
| `upload`          | `(filePath: string, contents: ReadableStream \| Buffer \| string, options?: { overwrite?: boolean })` | `void`          |
| `createDirectory` | `(directoryPath: string)`                                                                          | `void`             |
| `delete`          | `(filePath: string)`                                                                               | `void`             |
| `preview`         | `(filePath: string)`                                                                               | `FilePreview`      |

> `read()` loads the entire file into memory as a string. Files larger than 10 MB (default) are rejected — use `download()` for large files, or pass `{ maxSize: <bytes> }` to override.

## Path resolution

Paths can be **absolute** or **relative**:

- **Absolute** — starts with `/`, must begin with `/Volumes/` (e.g. `/Volumes/catalog/schema/vol/data.csv`)
- **Relative** — prepended with the volume path resolved from the environment variable (e.g. `data.csv` → `/Volumes/catalog/schema/uploads/data.csv`)

Path traversal (`../`) is rejected. If a relative path is used and the volume's environment variable is not set, an error is thrown.

The `list()` method with no arguments lists the volume root.

## Types

```ts
// Re-exported from @databricks/sdk-experimental
type DirectoryEntry = files.DirectoryEntry;
type DownloadResponse = files.DownloadResponse;

interface FileMetadata {
  /** File size in bytes. */
  contentLength: number | undefined;
  /** MIME content type of the file. */
  contentType: string | undefined;
  /** ISO 8601 timestamp of the last modification. */
  lastModified: string | undefined;
}

interface FilePreview extends FileMetadata {
  /** First portion of text content, or null for non-text files. */
  textPreview: string | null;
  /** Whether the file is detected as a text format. */
  isText: boolean;
  /** Whether the file is detected as an image format. */
  isImage: boolean;
}

type FileAction =
  | "list" | "read" | "download" | "raw"
  | "exists" | "metadata" | "preview"
  | "upload" | "mkdir" | "delete";

interface FileResource {
  /** Relative path within the volume. */
  path: string;
  /** The volume key (e.g. `"uploads"`). */
  volume: string;
  /** Content length in bytes — only present for uploads. */
  size?: number;
}

interface FilePolicyUser {
  /**
   * Identifier of the requesting caller. For end-user HTTP requests this is
   * the value of the `x-forwarded-user` header; for direct SDK calls and
   * header-less HTTP requests (which run as the service principal), this
   * is the service principal's ID.
   */
  id: string;
  /**
   * `true` when the call is executing as the service principal — either a
   * direct SDK call (`appKit.files(...)` without `asUser`), an HTTP request
   * with no forwarded headers, or the dev-mode fallback for an OBO volume
   * with a missing token. See the [policy user matrix](#policy-user-matrix)
   * for the full table.
   */
  isServicePrincipal?: boolean;
}

type FilePolicy = (
  action: FileAction,
  resource: FileResource,
  user: FilePolicyUser,
) => boolean | Promise<boolean>;

interface VolumeConfig {
  /** Access policy for this volume. */
  policy?: FilePolicy;
  /** Maximum upload size in bytes for this volume. */
  maxUploadSize?: number;
  /** Map of file extensions to MIME types for this volume. */
  customContentTypes?: Record<string, string>;
  /**
   * Per-volume auth mode. Inherits from `IFilesConfig.auth` when not set;
   * defaults to `"service-principal"`.
   */
  auth?: "service-principal" | "on-behalf-of-user";
}

interface VolumeAPI {
  list(directoryPath?: string): Promise<DirectoryEntry[]>;
  read(filePath: string, options?: { maxSize?: number }): Promise<string>;
  download(filePath: string): Promise<DownloadResponse>;
  exists(filePath: string): Promise<boolean>;
  metadata(filePath: string): Promise<FileMetadata>;
  upload(filePath: string, contents: ReadableStream | Buffer | string, options?: { overwrite?: boolean }): Promise<void>;
  createDirectory(directoryPath: string): Promise<void>;
  delete(filePath: string): Promise<void>;
  preview(filePath: string): Promise<FilePreview>;
}

/**
 * Volume handle: all VolumeAPI methods (run as the service principal by
 * default) + asUser() to force per-user execution at the SDK level.
 */
type VolumeHandle = VolumeAPI & {
  asUser: (req: Request) => VolumeAPI;
};
```

## Content-type resolution

`contentTypeFromPath(filePath, reported?, customTypes?)` resolves a file's MIME type:

1. Check `customContentTypes` map first (if configured).
2. Match the file extension against the built-in map.
3. Fall back to the server-reported type, or `application/octet-stream`.

Built-in extensions: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico`, `.html`, `.css`, `.js`, `.ts`, `.py`, `.txt`, `.md`, `.csv`, `.json`, `.jsonl`, `.xml`, `.yaml`, `.yml`, `.sql`, `.pdf`, `.ipynb`, `.parquet`, `.zip`, `.gz`.

## User context

HTTP routes execute as either the service principal or the end user, depending on the volume's [auth mode](#auth-modes):

- **Service-principal volumes** (the default): the SP's Databricks credentials are used for the API call. User identity is extracted from the `x-forwarded-user` header and passed to the volume's [access policy](#access-policies) for authorization, but the SDK call still runs as the SP. When the header is absent the policy is handed `{ id: <sp-id>, isServicePrincipal: true }` and decides whether to allow the call — in practice that branch only fires in development without a reverse proxy or when an upstream proxy is misconfigured, since real Databricks Apps runtimes always forward the header. UC grants on the **SP** determine what operations are possible.
- **On-behalf-of-user volumes**: the end user's access token (from `x-forwarded-access-token`) is used to mint the SDK client, so the API call runs with the user's identity. Both the policy and the SDK see the user. UC grants on the **end user** determine what operations are possible. In production, requests with a missing token return `401`; in development (`NODE_ENV === "development"`) they fall back to the SP with a warning.

The programmatic API returns a `VolumeHandle` that exposes all `VolumeAPI` methods directly and an `asUser(req)` method for forcing per-user execution. Calling a method without `asUser()` runs the policy and the SDK call as the SP. `asUser(req)` is a hard override at the SDK level: it forces every subsequent call to execute as the end user inside `runInUserContext`, regardless of the volume's `auth` setting. In production, `asUser(req)` throws `AuthenticationError.missingToken` when either `x-forwarded-user` or `x-forwarded-access-token` is absent — both headers are required. In development it falls back to the service principal instead, so local testing without a reverse proxy continues to work.

## Resource requirements

Volume resources are declared **dynamically** via `getResourceRequirements(config)` based on discovered + configured volumes. Each volume key generates a required resource with `WRITE_VOLUME` permission and a `DATABRICKS_VOLUME_{KEY_UPPERCASE}` environment variable.

For example, if `DATABRICKS_VOLUME_UPLOADS` and `DATABRICKS_VOLUME_EXPORTS` are set, calling `files()` generates two required volume resources validated at startup — no explicit `volumes` config needed.

The manifest declares the grant against the **service principal**. For OBO volumes (`auth: "on-behalf-of-user"`), the actual permission requirement is on the **end user** — communicate this out-of-band in your deployment documentation until the manifest schema gains a per-volume auth scope field.

## Error responses

All errors return JSON:

```json
{
  "error": "Human-readable message",
  "plugin": "files"
}
```

| Status | Description                                                    |
| ------ | -------------------------------------------------------------- |
| 400    | Missing or invalid `path` parameter                            |
| 403    | Policy denied "`{action}`" on volume "`{volumeKey}`"          |
| 404    | Unknown volume key                                             |
| 413    | Upload exceeds `maxUploadSize`                                 |
| 500    | Operation failed (SDK, network, upstream, or unhandled error)  |

## Frontend components

The `@databricks/appkit-ui` package provides ready-to-use React components for building a file browser:

### FileBrowser

A composable set of components for browsing, previewing, and managing files in a Unity Catalog Volume:

```tsx
import {
  DirectoryList,
  FileBreadcrumb,
  FilePreviewPanel,
} from "@databricks/appkit-ui/react";

function FileBrowserPage() {
  return (
    <div style={{ display: "flex", gap: 16 }}>
      <div style={{ flex: 1 }}>
        <FileBreadcrumb
          rootLabel="uploads"
          segments={["data"]}
          onNavigateToRoot={() => {}}
          onNavigateToSegment={() => {}}
        />
        <DirectoryList
          entries={[]}
          onEntryClick={() => {}}
          resolveEntryPath={(entry) => entry.path ?? ""}
        />
      </div>
      <FilePreviewPanel selectedFile={null} preview={null} />
    </div>
  );
}
```

See the [Files (UC) components](../api/appkit-ui/files/DirectoryList) reference for the full props API.
