---
sidebar_position: 3
---

# Plugins

Plugins are modular extensions that add capabilities to your AppKit application. They follow a defined lifecycle and have access to shared services like caching, telemetry, and streaming.

For complete API documentation, see the [`Plugin`](api/appkit/Class.Plugin.md) class reference.

## Built-in Plugins

### Server Plugin

Provides HTTP server capabilities with development and production modes.

**Key features:**
- Express server for REST APIs
- Vite dev server with hot module reload
- Static file serving for production
- Remote tunneling to deployed backends

The Server Plugin uses the deferred initialization phase to access routes from other plugins.

### Analytics Plugin

Enables SQL query execution against Databricks SQL Warehouses.

**Key features:**
- File-based SQL queries with automatic type generation
- Parameterized queries with type-safe [SQL helpers](api/appkit/Variable.sql.md)
- JSON and Arrow format support
- Built-in caching and retry logic
- Server-Sent Events (SSE) streaming

Store SQL queries in `config/queries/` directory and use parameterized queries with the [`sql`](api/appkit/Variable.sql.md) helper for type safety.

## Using Plugins

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

## Creating Custom Plugins

Extend the [`Plugin`](api/appkit/Class.Plugin.md) class and export with `toPlugin()`:

```typescript
import { Plugin, toPlugin } from "@databricks/app-kit";

interface MyPluginConfig {
  apiKey?: string;
}

export class MyPlugin extends Plugin<MyPluginConfig> {
  name = "myPlugin";
  envVars = ["MY_API_KEY"];

  async setup() {
    // Initialize your plugin
  }

  async shutdown() {
    // Clean up resources
  }
}

export const myPlugin = toPlugin<typeof MyPlugin, MyPluginConfig, "myPlugin">(
  MyPlugin,
  "myPlugin"
);
```

**Key extension points:**
- **Route injection**: Implement `injectRoutes()` to add custom endpoints using [`IAppRouter`](api/appkit/TypeAlias.IAppRouter.md)
- **Lifecycle hooks**: Override `setup()`, `shutdown()`, and `validateEnv()` methods
- **Shared services**:
  - **Cache management**: Access the cache service via `this.cache`. See [`CacheConfig`](api/appkit/Interface.CacheConfig.md) for configuration.
  - **Telemetry**: Instrument your plugin with traces and metrics via `this.telemetry`. See [`ITelemetry`](api/appkit/Interface.ITelemetry.md).
- **Execution interceptors**: Use `execute()` and `executeStream()` with [`StreamExecutionSettings`](api/appkit/Interface.StreamExecutionSettings.md)

See the [`Plugin`](api/appkit/Class.Plugin.md) API reference for complete documentation.

## Plugin Phases

Plugins initialize in three phases:

- **Core**: Reserved for framework-level plugins. Initializes first.
- **Normal**: Default phase for application plugins. Initializes after core.
- **Deferred**: Initializes last with access to other plugin instances via `config.plugins`. Use when your plugin depends on other plugins (e.g., Server Plugin).
