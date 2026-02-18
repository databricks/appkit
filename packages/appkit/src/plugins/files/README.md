# Files Plugin

The files plugin provides HTTP routes for Databricks Unity Catalog volume file operations.
Routes are automatically registered via `injectRoutes` and mounted at `/api/files/*`.

## Routes

All routes (except `/root`) execute in user context via `asUser(req)`.

| Method | Path        | Query/Body Params            | Response                                          | `exports()` method  |
| ------ | ----------- | ---------------------------- | ------------------------------------------------- | ------------------- |
| GET    | `/root`     | -                            | `{ root: string \| null }`                        | -                   |
| GET    | `/list`     | `?path` (optional)           | `DirectoryEntry[]`                                | `list()`            |
| GET    | `/read`     | `?path` (required)           | `text/plain` body                                 | `read()`            |
| GET    | `/download` | `?path` (required)           | Binary stream (`Content-Disposition: attachment`) | `download()`        |
| GET    | `/raw`      | `?path` (required)           | Binary stream (inline)                            | `download()`        |
| GET    | `/exists`   | `?path` (required)           | `{ exists: boolean }`                             | `exists()`          |
| GET    | `/metadata` | `?path` (required)           | `FileMetadata`                                    | `metadata()`        |
| GET    | `/preview`  | `?path` (required)           | `FilePreview`                                     | `preview()`         |
| POST   | `/upload`   | `?path` (required), raw body | `{ success: true }`                               | `upload()`          |
| POST   | `/mkdir`    | `body.path` (required)       | `{ success: true }`                               | `createDirectory()` |
| POST   | `/delete`   | `?path` (required)           | `{ success: true }`                               | `delete()`          |

## Error responses

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

## User context

Routes use `this.asUser(req)` which wraps the plugin's `getFilesClient()` so that the underlying `getWorkspaceClient()` returns a client scoped to the requesting user's Databricks credentials (on-behalf-of / OBO). The `/root` route is the only exception since it only reads plugin config.
