# Function: createApp()

```ts
function createApp<T>(config): Promise<PluginMap<T>>;
```

Defined in: [app-kit/src/core/app-kit.ts:167](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/core/app-kit.ts#L167)

Creates and initializes an App Kit application with plugins.

This is the main entry point for App Kit. It initializes telemetry, cache,
and all provided plugins in the correct lifecycle order (core → normal → deferred).

## Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `PluginData`\<`PluginConstructor`, `unknown`, `string`\>[] |

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `config` | \{ `cache?`: `CacheConfig`; `plugins?`: `T`; `telemetry?`: `TelemetryConfig`; \} | Application configuration |
| `config.cache?` | `CacheConfig` | Optional cache configuration (defaults to Lakebase with in-memory fallback) |
| `config.plugins?` | `T` | Array of plugin definitions created with plugin factories |
| `config.telemetry?` | `TelemetryConfig` | Optional telemetry configuration for observability |

## Returns

`Promise`\<`PluginMap`\<`T`\>\>

Promise resolving to initialized plugin map with type-safe plugin access

## Examples

Basic application with server and analytics
```typescript
import { createApp, server, analytics } from '@databricks/app-kit';

const app = await createApp({
  plugins: [
    server({ port: 8000 }),
    analytics({})
  ]
});
```

Application with custom telemetry and cache configuration
```typescript
import { createApp, server } from '@databricks/app-kit';

const app = await createApp({
  plugins: [server()],
  telemetry: {
    serviceName: 'my-app',
    enabled: true
  },
  cache: {
    enabled: true,
    ttl: 3600
  }
});
```
