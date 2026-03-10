---
sidebar_position: 7
---

# Creating custom plugins

If you need custom API routes or background logic, implement an AppKit plugin. The fastest way is to use the CLI:

```bash
npx @databricks/appkit plugin create
```

For a deeper understanding of the plugin structure, read on.

## Basic plugin example

Extend the [`Plugin`](../api/appkit/Class.Plugin.md) class and export with `toPlugin()`:

```typescript
import { Plugin, toPlugin, type PluginManifest } from "@databricks/appkit";
import type express from "express";

class MyPlugin extends Plugin {
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
            key: { env: "MY_API_KEY", description: "Secret key name" }
          }
        }
      ],
      optional: []
    }
  } satisfies PluginManifest<"myPlugin">;

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
    return {
      myCustomMethod: this.myCustomMethod
    }
  }
}

export const myPlugin = toPlugin(MyPlugin);
```

## Config-dependent resources

The manifest defines resources as either `required` (always needed) or `optional` (may be needed).
For resources that become required based on plugin configuration, implement a static
`getResourceRequirements(config)` method:

```typescript
interface MyPluginConfig extends BasePluginConfig {
  enableCaching?: boolean;
}

class MyPlugin extends Plugin<MyPluginConfig> {
  static manifest = {
    name: "myPlugin",
    displayName: "My Plugin",
    description: "A plugin with optional caching",
    resources: {
      required: [
        { type: "sql_warehouse", alias: "warehouse", resourceKey: "sqlWarehouse", description: "Query execution", permission: "CAN_USE", fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } } }
      ],
      optional: [
        // Listed as optional in manifest for static analysis
        { type: "database", alias: "cache", resourceKey: "cache", description: "Query result caching (if enabled)", permission: "CAN_CONNECT_AND_CREATE", fields: { instance_name: { env: "DATABRICKS_CACHE_INSTANCE" }, database_name: { env: "DATABRICKS_CACHE_DB" } } }
      ]
    }
  } satisfies PluginManifest<"myPlugin">;

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
        required: true  // Mark as required at runtime
      });
    }
    return resources;
  }
}
```

This pattern allows:
- **Static tools** (CLI, docs) to show all possible resources
- **Runtime validation** to enforce resources based on actual configuration

## Key extension points

- **Route injection**: Implement `injectRoutes()` to add custom endpoints using [`IAppRouter`](../api/appkit/TypeAlias.IAppRouter.md)
- **Lifecycle hooks**: Override `setup()`, and `shutdown()` methods
- **Shared services**:
  - **Cache management**: Access the cache service via `this.cache`. See [`CacheConfig`](../api/appkit/Interface.CacheConfig.md) for configuration.
  - **Telemetry**: Instrument your plugin with traces and metrics via `this.telemetry`. See [`ITelemetry`](../api/appkit/Interface.ITelemetry.md).
- **Execution interceptors**: Use `execute()` and `executeStream()` with [`StreamExecutionSettings`](../api/appkit/Interface.StreamExecutionSettings.md)

**Consuming your plugin programmatically**

Optionally, you may want to provide a way to consume your plugin programmatically using the AppKit object.
To do that, your plugin needs to implement the `exports` method, returning an object with the methods you want to expose. From the previous example, the plugin could be consumed as follows:

```ts
const AppKit = await createApp({
  plugins: [
    server({ port: 8000 }),
    analytics(),
    myPlugin(),
  ],
});

AppKit.myPlugin.myCustomMethod();
```

See the [`Plugin`](../api/appkit/Class.Plugin.md) API reference for complete documentation.
