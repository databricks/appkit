# Function: getPluginManifest()

```ts
function getPluginManifest(plugin: PluginConstructor): PluginManifest;
```

Loads and validates the manifest from a plugin constructor.

All plugins must have a static `manifest` property that declares their
metadata and resource requirements.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `plugin` | `PluginConstructor` | The plugin constructor class |

## Returns

[`PluginManifest`](Interface.PluginManifest.md)

The validated plugin manifest

## Throws

If the manifest is missing or invalid

## Example

```typescript
import { AnalyticsPlugin } from '@databricks/appkit';
import { getPluginManifest } from './manifest-loader';

const manifest = getPluginManifest(AnalyticsPlugin);
console.log('Required resources:', manifest.resources.required);
```
