# Function: createApp()

```ts
function createApp<T>(config: {
  cache?: CacheConfig;
  client?: WorkspaceClient;
  plugins?: T;
  telemetry?: TelemetryConfig;
}): Promise<PluginMap<T>>;
```

Bootstraps AppKit with the provided configuration.

Initializes telemetry, cache, and service context, then registers plugins
in phase order (core, normal, deferred) and awaits their setup.
The returned object maps each plugin name to its `exports()` API,
with an `asUser(req)` method for user-scoped execution.

## Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* [`PluginData`](TypeAlias.PluginData.md)\<`PluginConstructor`, `unknown`, `string`\>[] |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | \{ `cache?`: [`CacheConfig`](Interface.CacheConfig.md); `client?`: `WorkspaceClient`; `plugins?`: `T`; `telemetry?`: [`TelemetryConfig`](Interface.TelemetryConfig.md); \} |
| `config.cache?` | [`CacheConfig`](Interface.CacheConfig.md) |
| `config.client?` | `WorkspaceClient` |
| `config.plugins?` | `T` |
| `config.telemetry?` | [`TelemetryConfig`](Interface.TelemetryConfig.md) |

## Returns

`Promise`\<`PluginMap`\<`T`\>\>

A `PluginMap` keyed by plugin name with typed exports

## Examples

```ts
import { createApp, server } from "@databricks/appkit";

await createApp({
  plugins: [server()],
});
```

```ts
import { createApp, server, analytics } from "@databricks/appkit";

const appkit = await createApp({
  plugins: [server({ autoStart: false }), analytics({})],
});

appkit.server.extend((app) => {
  app.get("/custom", (_req, res) => res.json({ ok: true }));
});
await appkit.server.start();
```
