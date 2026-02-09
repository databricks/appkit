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

## Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `PluginData`\<`PluginConstructor`, `unknown`, `string`\>[] |

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
