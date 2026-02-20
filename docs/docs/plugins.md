---
sidebar_position: 3
---

# Plugins

Plugins are modular extensions that add capabilities to your AppKit application. They follow a defined lifecycle and have access to shared services like caching, telemetry, and streaming.

For complete API documentation, see the [`Plugin`](api/appkit/Class.Plugin.md) class reference.

## Built-in plugins

### Server plugin

Provides HTTP server capabilities with development and production modes.

**Key features:**

- Express server for REST APIs
- Vite dev server with hot module reload
- Static file serving for production
- Remote tunneling to deployed backends

The Server plugin uses the deferred initialization phase to access routes from other plugins.

#### What it does

- Starts an Express server (default `host=0.0.0.0`, `port=8000`)
- Mounts plugin routes under `/api/<pluginName>/...`
- Adds `/health` endpoint (returns `{ status: "ok" }`)
- Serves frontend:
  - **Development** (`NODE_ENV=development`): runs a Vite dev server in middleware mode
  - **Production**: auto-detects static frontend directory (checks `dist`, `client/dist`, `build`, `public`, `out`)

#### Minimal server example

The smallest valid AppKit server:

```ts
// server/index.ts
import { createApp, server } from "@databricks/appkit";

await createApp({
  plugins: [server()],
});
```

#### Manual server start example

When you need to extend Express with custom routes:

```ts
import { createApp, server } from "@databricks/appkit";

const appkit = await createApp({
  plugins: [server({ autoStart: false })],
});

appkit.server.extend((app) => {
  app.get("/custom", (_req, res) => res.json({ ok: true }));
});

await appkit.server.start();
```

#### Configuration options

```ts
import { createApp, server } from "@databricks/appkit";

await createApp({
  plugins: [
    server({
      port: 8000, // default: Number(process.env.DATABRICKS_APP_PORT) || 8000
      host: "0.0.0.0", // default: process.env.FLASK_RUN_HOST || "0.0.0.0"
      autoStart: true, // default: true
      staticPath: "dist", // optional: force a specific static directory
    }),
  ],
});
```

### Analytics plugin

Enables SQL query execution against Databricks SQL Warehouses.

**Key features:**

- File-based SQL queries with automatic type generation
- Parameterized queries with type-safe [SQL helpers](api/appkit/Variable.sql.md)
- JSON and Arrow format support
- Built-in caching and retry logic
- Server-Sent Events (SSE) streaming

#### Basic usage

```ts
import { analytics, createApp, server } from "@databricks/appkit";

await createApp({
  plugins: [server(), analytics({})],
});
```

#### Where queries live

- Put `.sql` files in `config/queries/`
- Query key is the filename without `.sql` (e.g. `spend_summary.sql` → `"spend_summary"`)

#### SQL parameters

Use `:paramName` placeholders and optionally annotate parameter types using SQL comments:

```sql
-- @param startDate DATE
-- @param endDate DATE
-- @param limit NUMERIC
SELECT ...
WHERE usage_date BETWEEN :startDate AND :endDate
LIMIT :limit
```

**Supported `-- @param` types** (case-insensitive):

- `STRING`, `NUMERIC`, `BOOLEAN`, `DATE`, `TIMESTAMP`, `BINARY`

#### Server-injected parameters

`:workspaceId` is **injected by the server** and **must not** be annotated:

```sql
WHERE workspace_id = :workspaceId
```

#### HTTP endpoints

The analytics plugin exposes these endpoints (mounted under `/api/analytics`):

- `POST /api/analytics/query/:query_key`
- `POST /api/analytics/users/me/query/:query_key`
- `GET /api/analytics/arrow-result/:jobId`
- `GET /api/analytics/users/me/arrow-result/:jobId`

#### Format options

- `format: "JSON"` (default) returns JSON rows
- `format: "ARROW"` returns an Arrow "statement_id" payload over SSE, then the client fetches binary Arrow from `/api/analytics/arrow-result/:jobId`

### Files plugin

Provides HTTP routes and a programmatic API for Databricks Unity Catalog volume file operations (list, read, download, upload, delete, preview).

Routes are mounted at `/api/files/*`.

#### Configuration

| Option               | Type                     | Default  | Description                                                                                                                                                                              |
| -------------------- | ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultVolume`      | `string`                 | —        | Absolute volume path used to resolve relative file paths (e.g. `"/Volumes/catalog/schema/vol"`).                                                                                         |
| `timeout`            | `number`                 | Per-tier | Operation timeout in milliseconds. Overrides the built-in per-tier defaults (30 s read, 600 s write).                                                                                    |
| `customContentTypes` | `Record<string, string>` | —        | Map of file extensions to MIME types that takes priority over the built-in extension map. Keys should include the leading dot (e.g. `{ ".parquet": "application/vnd.apache.parquet" }`). |

#### Programmatic API

After registration, the plugin exposes methods on the app instance via `app.files.<method>()`:

| Method            | Signature                                                                                                          | Description                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `list`            | `(path?: string) => Promise<DirectoryEntry[]>`                                                                     | List entries in a directory. Defaults to the configured `defaultVolume` root. |
| `read`            | `(path: string) => Promise<string>`                                                                                | Read a file and return its contents as a UTF-8 string.                        |
| `download`        | `(path: string) => Promise<DownloadResponse>`                                                                      | Download a file as a readable stream.                                         |
| `exists`          | `(path: string) => Promise<boolean>`                                                                               | Check whether a file exists.                                                  |
| `metadata`        | `(path: string) => Promise<FileMetadata>`                                                                          | Retrieve metadata (size, content type, last modified) for a file.             |
| `upload`          | `(path: string, contents: ReadableStream \| Buffer \| string, options?: { overwrite?: boolean }) => Promise<void>` | Upload a file to a Unity Catalog volume.                                      |
| `createDirectory` | `(path: string) => Promise<void>`                                                                                  | Create a directory in a Unity Catalog volume.                                 |
| `delete`          | `(path: string) => Promise<void>`                                                                                  | Delete a file or directory from a Unity Catalog volume.                       |
| `preview`         | `(path: string) => Promise<FilePreview>`                                                                           | Get a preview of a file including metadata and a text excerpt.                |

#### HTTP Routes

All routes are mounted under `/api/files`. File paths are passed via the `path` query parameter.

| Method | Path                        | Description                                          |
| ------ | --------------------------- | ---------------------------------------------------- |
| `GET`  | `/api/files/root`           | Returns the configured `defaultVolume` path.         |
| `GET`  | `/api/files/list?path=`     | List directory contents.                             |
| `GET`  | `/api/files/read?path=`     | Read a file as plain text.                           |
| `GET`  | `/api/files/download?path=` | Download a file as an attachment.                    |
| `GET`  | `/api/files/raw?path=`      | Serve a file inline with its detected content type.  |
| `GET`  | `/api/files/exists?path=`   | Check whether a file exists (`{ exists: boolean }`). |
| `GET`  | `/api/files/metadata?path=` | Retrieve file metadata (size, type, last modified).  |
| `GET`  | `/api/files/preview?path=`  | Get a file preview with text excerpt.                |
| `POST` | `/api/files/upload?path=`   | Upload a file (stream the request body).             |
| `POST` | `/api/files/mkdir`          | Create a directory (`{ path }` in body).             |
| `POST` | `/api/files/delete?path=`   | Delete a file or directory.                          |

#### Execution defaults

Operations use three tiers of execution settings:

| Tier         | Cache    | Retry                   | Timeout             | Operations                            |
| ------------ | -------- | ----------------------- | ------------------- | ------------------------------------- |
| **Read**     | 60 s TTL | 3 attempts, 1 s backoff | 30 s                | list, read, exists, metadata, preview |
| **Download** | Disabled | 3 attempts, 1 s backoff | 30 s (stream start) | download, raw                         |
| **Write**    | Disabled | Disabled                | 600 s               | upload, mkdir, delete                 |

#### Basic usage

```ts
import { createApp, files } from "@databricks/appkit";

const app = await createApp({
  plugins: [files({ defaultVolume: "/Volumes/catalog/schema/vol" })],
});
```

#### List files in a directory

```ts
const entries = await app.files.list("/path/to/dir");
for (const entry of entries) {
  console.log(entry.name, entry.is_directory);
}
```

#### Read a file as a string

```ts
const content = await app.files.read("data/config.json");
const config = JSON.parse(content);
```

#### Download a file as a stream

```ts
const response = await app.files.download("reports/export.csv");
// response.contents is a ReadableStream
```

#### Upload a file

```ts
await app.files.upload("uploads/report.pdf", fileBuffer, {
  overwrite: true,
});
```

#### Check if a file exists

```ts
const found = await app.files.exists("data/config.json");
if (!found) {
  console.log("File not found");
}
```

#### Get file metadata

```ts
const meta = await app.files.metadata("data/report.csv");
console.log(meta.contentLength, meta.contentType, meta.lastModified);
```

#### Preview a file

```ts
const preview = await app.files.preview("data/readme.md");
// { contentLength, contentType, lastModified, textPreview, isText, isImage }
```

#### Custom content types

```ts
const app = await createApp({
  plugins: [
    files({
      defaultVolume: "/Volumes/catalog/schema/vol",
      customContentTypes: {
        ".dbx": "application/x-databricks",
        ".arrow": "application/vnd.apache.arrow.stream",
      },
    }),
  ],
});
```

#### User-scoped operations in a route handler

```ts
// Inside a custom plugin route handler:
const userFiles = this.asUser(req);
const entries = await userFiles.files.list();
```

### Execution context and `asUser(req)`

AppKit manages Databricks authentication via two contexts:

- **ServiceContext** (singleton): Initialized at app startup with service principal credentials
- **ExecutionContext**: Determined at runtime - either service principal or user context

#### Headers for user context

- `x-forwarded-user`: required in production; identifies the user
- `x-forwarded-access-token`: required for user token passthrough

#### Using `asUser(req)` for user-scoped operations

The `asUser(req)` pattern allows plugins to execute operations using the requesting user's credentials:

```ts
// In a custom plugin route handler
router.post("/users/me/data", async (req, res) => {
  // Execute as the user (uses their Databricks permissions)
  const result = await this.asUser(req).query("SELECT ...");
  res.json(result);
});

// Service principal execution (default)
router.post("/system/data", async (req, res) => {
  const result = await this.query("SELECT ...");
  res.json(result);
});
```

#### Context helper functions

Exported from `@databricks/appkit`:

- `getCurrentUserId()`: Returns user ID in user context, service user ID otherwise
- `getWorkspaceClient()`: Returns the appropriate WorkspaceClient for current context
- `getWarehouseId()`: `Promise<string>` (from `DATABRICKS_WAREHOUSE_ID` or auto-selected in dev)
- `getWorkspaceId()`: `Promise<string>` (from `DATABRICKS_WORKSPACE_ID` or fetched)
- `isInUserContext()`: Returns `true` if currently executing in user context

#### Development mode behavior

In local development (`NODE_ENV=development`), if `asUser(req)` is called without a user token, it logs a warning and falls back to the service principal.

## Using plugins

Configure plugins when creating your AppKit instance:

```typescript
import { createApp, server, analytics } from "@databricks/appkit";

const AppKit = await createApp({
  plugins: [server({ port: 8000 }), analytics()],
});
```

For complete configuration options, see [`createApp`](api/appkit/Function.createApp.md).

## Creating custom plugins

If you need custom API routes or background logic, implement an AppKit plugin.

### Basic plugin example

Extend the [`Plugin`](api/appkit/Class.Plugin.md) class and export with `toPlugin()`:

```typescript
import { Plugin, toPlugin } from "@databricks/appkit";
import type express from "express";

class MyPlugin extends Plugin {
  name = "myPlugin";

  // Define resource requirements in the static manifest
  static manifest = {
    name: "myPlugin",
    displayName: "My Plugin",
    description: "A custom plugin",
    resources: {
      required: [
        {
          type: "secret",
          alias: "apiKey",
          resourceKey: "apiKey",
          description: "API key for external service",
          permission: "READ",
          fields: {
            scope: { env: "MY_SECRET_SCOPE", description: "Secret scope" },
            key: { env: "MY_API_KEY", description: "Secret key name" },
          },
        },
      ],
      optional: [],
    },
  };

  async setup() {
    // Initialize your plugin
  }

  myCustomMethod() {
    // Some implementation
  }

  async shutdown() {
    // Clean up resources
  }

  exports() {
    // an object with the methods from this plugin to expose
    return {
      myCustomMethod: this.myCustomMethod,
    };
  }
}

export const myPlugin = toPlugin<
  typeof MyPlugin,
  Record<string, never>,
  "myPlugin"
>(MyPlugin, "myPlugin");
```

### Config-dependent resources

The manifest defines resources as either `required` (always needed) or `optional` (may be needed).
For resources that become required based on plugin configuration, implement a static
`getResourceRequirements(config)` method:

```typescript
interface MyPluginConfig extends BasePluginConfig {
  enableCaching?: boolean;
}

class MyPlugin extends Plugin<MyPluginConfig> {
  name = "myPlugin";

  static manifest = {
    name: "myPlugin",
    displayName: "My Plugin",
    description: "A plugin with optional caching",
    resources: {
      required: [
        {
          type: "sql_warehouse",
          alias: "warehouse",
          resourceKey: "sqlWarehouse",
          description: "Query execution",
          permission: "CAN_USE",
          fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
        },
      ],
      optional: [
        // Listed as optional in manifest for static analysis
        {
          type: "database",
          alias: "cache",
          resourceKey: "cache",
          description: "Query result caching (if enabled)",
          permission: "CAN_CONNECT_AND_CREATE",
          fields: {
            instance_name: { env: "DATABRICKS_CACHE_INSTANCE" },
            database_name: { env: "DATABRICKS_CACHE_DB" },
          },
        },
      ],
    },
  };

  // Runtime: Convert optional resources to required based on config
  static getResourceRequirements(config: MyPluginConfig) {
    const resources = [];
    if (config.enableCaching) {
      // When caching is enabled, Database becomes required
      resources.push({
        type: "database",
        alias: "cache",
        resourceKey: "cache",
        description: "Query result caching",
        permission: "CAN_CONNECT_AND_CREATE",
        fields: {
          instance_name: { env: "DATABRICKS_CACHE_INSTANCE" },
          database_name: { env: "DATABRICKS_CACHE_DB" },
        },
        required: true, // Mark as required at runtime
      });
    }
    return resources;
  }
}
```

This pattern allows:

- **Static tools** (CLI, docs) to show all possible resources
- **Runtime validation** to enforce resources based on actual configuration

### Key extension points

- **Route injection**: Implement `injectRoutes()` to add custom endpoints using [`IAppRouter`](api/appkit/TypeAlias.IAppRouter.md)
- **Lifecycle hooks**: Override `setup()`, and `shutdown()` methods
- **Shared services**:
  - **Cache management**: Access the cache service via `this.cache`. See [`CacheConfig`](api/appkit/Interface.CacheConfig.md) for configuration.
  - **Telemetry**: Instrument your plugin with traces and metrics via `this.telemetry`. See [`ITelemetry`](api/appkit/Interface.ITelemetry.md).
- **Execution interceptors**: Use `execute()` and `executeStream()` with [`StreamExecutionSettings`](api/appkit/Interface.StreamExecutionSettings.md)

**Consuming your plugin programmatically**

Optionally, you may want to provide a way to consume your plugin programmatically using the AppKit object.
To do that, your plugin needs to implement the `exports` method, returning an object with the methods you want to expose. From the previous example, the plugin could be consumed as follows:

```ts
const AppKit = await createApp({
  plugins: [server({ port: 8000 }), analytics(), myPlugin()],
});

AppKit.myPlugin.myCustomMethod();
```

See the [`Plugin`](api/appkit/Class.Plugin.md) API reference for complete documentation.

## Caching

AppKit provides both global and plugin-level caching capabilities.

### Global cache configuration

```ts
await createApp({
  plugins: [server(), analytics({})],
  cache: {
    enabled: true,
    ttl: 3600, // seconds
    strictPersistence: false,
  },
});
```

Storage auto-selects **Lakebase V1 (Provisioned) persistent cache when healthy**, otherwise falls back to in-memory. Support for Lakebase Autoscaling coming soon.

### Plugin-level caching

Inside a Plugin subclass:

```ts
const value = await this.cache.getOrExecute(
  ["myPlugin", "data", userId],
  async () => expensiveWork(),
  userKey,
  { ttl: 300 },
);
```

## Plugin phases

Plugins initialize in three phases:

- **Core**: Reserved for framework-level plugins. Initializes first.
- **Normal**: Default phase for application plugins. Initializes after core.
- **Deferred**: Initializes last with access to other plugin instances via `config.plugins`. Use when your plugin depends on other plugins (e.g., Server Plugin).
