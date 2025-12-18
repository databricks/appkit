# Function: createApp()

```ts
function createApp<T>(config): Promise<PluginMap<T>>;
```

Defined in: [app-kit/src/core/app-kit.ts:124](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/core/app-kit.ts#L124)

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
