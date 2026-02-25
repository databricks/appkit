# Function: getPluginManifest()

```ts
function getPluginManifest(plugin: PluginConstructor): PluginManifest;
```

Loads and validates the manifest from a plugin constructor.
Normalizes string type/permission to strict ResourceType/ResourcePermission.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `plugin` | `PluginConstructor` | The plugin constructor class |

## Returns

[`PluginManifest`](Interface.PluginManifest.md)

The validated, normalized plugin manifest

## Throws

If the manifest is missing, invalid, or has invalid resource type/permission
