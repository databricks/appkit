# Files Plugin

The files plugin provides HTTP routes and a programmatic API for Databricks Unity Catalog volume file operations. It supports listing, reading, downloading, uploading, deleting, and previewing files with built-in caching, retry, and timeout handling via the execution interceptor pipeline.

Routes are automatically registered via `injectRoutes` and mounted at `/api/files/*`.

## Configuration

The plugin accepts an `IFilesConfig` object:

```ts
interface IFilesConfig {
  timeout?: number;       // Operation timeout in ms
  defaultVolume?: string; // Absolute volume path, e.g. "/Volumes/catalog/schema/vol"
}
```

Usage with the `files()` factory:

```ts
import { files } from "@databricks/appkit";

files({ defaultVolume: "/Volumes/catalog/schema/vol" });
```

## Routes

All routes (except `/root`) execute in user context via `asUser(req)`.

| Method | Path        | Query/Body Params            | Response                                          | `exports()` method  |
| ------ | ----------- | ---------------------------- | ------------------------------------------------- | ------------------- |
| GET    | `/root`     | -                            | `{ root: string \| null }`                        | -                   |
| GET    | `/list`     | `?path` (optional)           | `DirectoryEntry[]`                                | `list()`            |
| GET    | `/read`     | `?path` (required)           | `text/plain` body                                 | `read()`            |
| GET    | `/download` | `?path` (required)           | Binary stream (`Content-Disposition: attachment`) | `download()`        |
| GET    | `/raw`      | `?path` (required)           | Binary stream (inline, no Content-Disposition)    | `download()` (inline) |
| GET    | `/exists`   | `?path` (required)           | `{ exists: boolean }`                             | `exists()`          |
| GET    | `/metadata` | `?path` (required)           | `FileMetadata`                                    | `metadata()`        |
| GET    | `/preview`  | `?path` (required)           | `FilePreview`                                     | `preview()`         |
| POST   | `/upload`   | `?path` (required), raw body | `{ success: true }`                               | `upload()`          |
| POST   | `/mkdir`    | `body.path` (required)       | `{ success: true }`                               | `createDirectory()` |
| POST   | `/delete`   | `?path` (required)           | `{ success: true }`                               | `delete()`          |

## Execution Defaults

Every operation runs through the interceptor pipeline with tier-specific defaults:

| Tier       | Cache   | Retry | Timeout | Operations                               |
| ---------- | ------- | ----- | ------- | ---------------------------------------- |
| **Read**   | 60 s    | 3×    | 30 s    | list, read, exists, metadata, preview    |
| **Download** | none  | 3×    | 30 s    | download, raw                            |
| **Write**  | none    | none  | 600 s   | upload, mkdir, delete                    |

Retry uses exponential backoff with a 1 s initial delay.

## Cache Invalidation

Write operations (`upload`, `mkdir`, `delete`) automatically invalidate the cached `list` entry for the parent directory so subsequent listings reflect the change.

## Types

```ts
// Plugin configuration
interface IFilesConfig {
  timeout?: number;
  defaultVolume?: string;
}

// Re-exported from @databricks/sdk-experimental
type DirectoryEntry = files.DirectoryEntry;
type DownloadResponse = files.DownloadResponse;

// File metadata returned by /metadata
interface FileMetadata {
  contentLength: number | undefined;
  contentType: string | undefined;
  lastModified: string | undefined;
}

// File preview returned by /preview (extends FileMetadata)
interface FilePreview extends FileMetadata {
  textPreview: string | null; // First 1 KB of text content, or null for non-text
  isText: boolean;
  isImage: boolean;
}
```

## `exports()` API

The programmatic API returned by `exports()` for server-side use:

| Method              | Signature                                                              | Returns                  |
| ------------------- | ---------------------------------------------------------------------- | ------------------------ |
| `list`              | `(directoryPath?: string)`                                             | `DirectoryEntry[]`       |
| `read`              | `(filePath: string)`                                                   | `string`                 |
| `download`          | `(filePath: string)`                                                   | `DownloadResponse`       |
| `exists`            | `(filePath: string)`                                                   | `boolean`                |
| `metadata`          | `(filePath: string)`                                                   | `FileMetadata`           |
| `upload`            | `(filePath: string, contents: ReadableStream \| Buffer \| string, options?: { overwrite?: boolean })` | `void` |
| `createDirectory`   | `(directoryPath: string)`                                              | `void`                   |
| `delete`            | `(filePath: string)`                                                   | `void`                   |
| `preview`           | `(filePath: string, options?: { maxBytes?: number })`                  | `FilePreview`            |

## Path Resolution

Paths can be **absolute** or **relative**:

- **Absolute** — starts with `/`, used as-is (e.g. `/Volumes/catalog/schema/vol/data.csv`)
- **Relative** — prepended with `defaultVolume` (e.g. `data.csv` → `/Volumes/catalog/schema/vol/data.csv`)

If a relative path is used and no `defaultVolume` is configured, an error is thrown.

The `list()` method with no arguments lists the `defaultVolume` root.

## Content-Type Resolution

`contentTypeFromPath(filePath, reported?)` resolves a file's content type:

1. If the server reports a content type other than `application/octet-stream`, use it.
2. Otherwise, match the file extension against a built-in map.
3. Fall back to the reported type or `application/octet-stream`.

Supported extensions: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico`, `.json`, `.xml`, `.html`, `.css`, `.js`, `.txt`, `.md`, `.csv`, `.pdf`.

## Error Responses

All errors return JSON with the shape:

```json
{
  "error": "Human-readable message",
  "plugin": "files"
}
```

## HTTP Status Codes

| Status | Description                             |
| ------ | --------------------------------------- |
| 400    | Missing required `path` parameter       |
| 500    | Operation failed (SDK or network error) |

## User Context

Routes use `this.asUser(req)` which wraps the plugin's `getFilesClient()` so that the underlying `getWorkspaceClient()` returns a client scoped to the requesting user's Databricks credentials (on-behalf-of / OBO). The `/root` route is the only exception since it only reads plugin config.
