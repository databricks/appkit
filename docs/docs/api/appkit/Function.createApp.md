# Function: createApp()

```ts
function createApp<T>(config: {
  cache?: CacheConfig;
  client?: WorkspaceClient;
  onPluginsReady?: (appkit: PluginMap<T>) => void | Promise<void>;
  plugins?: T;
  telemetry?: TelemetryConfig;
}): Promise<PluginMap<T>>;
```

Bootstraps AppKit with the provided configuration.

Initializes telemetry, cache, and service context, then registers plugins
in phase order (core, normal, deferred) and awaits their setup.
If a `onPluginsReady` callback is provided it runs after plugin setup but
before the server starts, giving you access to the full appkit handle
for registering custom routes or performing async setup.
The returned object maps each plugin name to its `exports()` API,
with an `asUser(req)` method for user-scoped execution.

## Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* [`PluginData`](TypeAlias.PluginData.md)\<`PluginConstructor`, `unknown`, `string`\>[] |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | \{ `cache?`: [`CacheConfig`](Interface.CacheConfig.md); `client?`: `WorkspaceClient`; `onPluginsReady?`: (`appkit`: `PluginMap`\<`T`\>) => `void` \| `Promise`\<`void`\>; `plugins?`: `T`; `telemetry?`: [`TelemetryConfig`](Interface.TelemetryConfig.md); \} |
| `config.cache?` | [`CacheConfig`](Interface.CacheConfig.md) |
| `config.client?` | `WorkspaceClient` |
| `config.onPluginsReady?` | (`appkit`: `PluginMap`\<`T`\>) => `void` \| `Promise`\<`void`\> |
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

await createApp({
  plugins: [server(), analytics({})],
  onPluginsReady(appkit) {
    appkit.server.extend((app) => {
      app.get("/custom", (_req, res) => res.json({ ok: true }));
    });
  },
});
```
