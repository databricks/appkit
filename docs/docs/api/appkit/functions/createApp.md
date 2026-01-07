# Function: createApp()

```ts
function createApp<T>(config): Promise<PluginMap<T>>;
```

Defined in: [appkit/src/core/appkit.ts:124](https://github.com/databricks/appkit/blob/main/packages/appkit/src/core/appkit.ts#L124)

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
