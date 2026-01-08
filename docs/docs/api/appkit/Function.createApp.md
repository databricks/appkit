# Function: createApp()

```ts
function createApp<T>(config: {
  cache?: CacheConfig;
  plugins?: T;
  telemetry?: TelemetryConfig;
}): Promise<PluginMap<T>>;
```

Defined in: [appkit/src/core/appkit.ts:133](https://github.com/databricks/appkit/blob/main/packages/appkit/src/core/appkit.ts#L133)

Bootstraps AppKit with the provided configuration.

## Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `PluginData`\<`PluginConstructor`, `unknown`, `string`\>[] |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | \{ `cache?`: `CacheConfig`; `plugins?`: `T`; `telemetry?`: `TelemetryConfig`; \} |
| `config.cache?` | `CacheConfig` |
| `config.plugins?` | `T` |
| `config.telemetry?` | `TelemetryConfig` |

## Returns

`Promise`\<`PluginMap`\<`T`\>\>
