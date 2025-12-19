# Function: appKitTypesPlugin()

```ts
function appKitTypesPlugin(options?): Plugin$1;
```

Defined in: [appkit/src/type-generator/vite-plugin.ts:21](https://github.com/databricks/appkit/blob/main/packages/appkit/src/type-generator/vite-plugin.ts#L21)

Vite plugin to generate types for AppKit queries.
Calls `npx appkit-generate-types` under the hood.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | `AppKitTypesPluginOptions` | Options to override default values. |

## Returns

`Plugin$1`

Vite plugin to generate types for AppKit queries.
