# Function: defineManifest()

```ts
function defineManifest<TName>(manifest: unknown): PluginManifest<TName>;
```

Validates a raw manifest (typically a `manifest.json` import) against the
canonical Zod schema and returns it as a strict [PluginManifest](Interface.PluginManifest.md).

Plugins declare `static manifest = defineManifest<"my-plugin">(manifestJson)`
instead of casting. A plain `as PluginManifest` can't work: a JSON import
widens every field to `string`, and `PluginManifest.resources[].type` is the
nominal `ResourceType` enum, so the structural JSON shape never assigns. The
single internal assertion here bridges that gap in one audited place — after
`parse()` has confirmed the values are real `ResourceType`/permission strings
— rather than every plugin repeating `as unknown as PluginManifest`.

Pass the plugin name as `TName` so the literal is preserved: `toPlugin`
derives the typed plugin key from `manifest.name`, and a widened `string`
there would collapse the typed plugin registry.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TName` *extends* `string` | `string` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `manifest` | `unknown` |

## Returns

[`PluginManifest`](Interface.PluginManifest.md)\<`TName`\>

## Throws

If the manifest doesn't match the schema.
