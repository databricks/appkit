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
      port: 8000,          // default: Number(process.env.DATABRICKS_APP_PORT) || 8000
      host: "0.0.0.0",     // default: process.env.FLASK_RUN_HOST || "0.0.0.0"
      autoStart: true,     // default: true
      staticPath: "dist",  // optional: force a specific static directory
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

- `getExecutionContext()`: Returns current context (user or service)
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
import { createApp, server, analytics } from "@databricks/app-kit";

const AppKit = await createApp({
  plugins: [
    server({ port: 8000 }),
    analytics(),
  ],
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
  name = "my-plugin";
  envVars = [];                 // list required env vars here

  injectRoutes(router: express.Router) {
    this.route(router, {
      name: "hello",
      method: "get",
      path: "/hello",
      handler: async (_req, res) => {
        res.json({ ok: true });
      },
    });
  }
}

export const myPlugin = toPlugin<typeof MyPlugin, Record<string, never>, "my-plugin">(
  MyPlugin,
  "my-plugin",
);
```

### Key extension points

- **Route injection**: Implement `injectRoutes()` to add custom endpoints using [`IAppRouter`](api/appkit/TypeAlias.IAppRouter.md)
- **Lifecycle hooks**: Override `setup()`, `shutdown()`, and `validateEnv()` methods
- **Shared services**:
  - **Cache management**: Access the cache service via `this.cache`. See [`CacheConfig`](api/appkit/Interface.CacheConfig.md) for configuration.
  - **Telemetry**: Instrument your plugin with traces and metrics via `this.telemetry`. See [`ITelemetry`](api/appkit/Interface.ITelemetry.md).
- **Execution interceptors**: Use `execute()` and `executeStream()` with [`StreamExecutionSettings`](api/appkit/Interface.StreamExecutionSettings.md)

See the [`Plugin`](api/appkit/Class.Plugin.md) API reference for complete documentation.

## Caching

AppKit provides both global and plugin-level caching capabilities.

### Global cache configuration

```ts
await createApp({
  plugins: [server(), analytics({})],
  cache: {
    enabled: true,
    ttl: 3600,              // seconds
    strictPersistence: false,
  },
});
```

Storage auto-selects **Lakebase persistent cache when healthy**, otherwise falls back to in-memory.

### Plugin-level caching

Inside a Plugin subclass:

```ts
const value = await this.cache.getOrExecute(
  ["my-plugin", "data", userId],
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
