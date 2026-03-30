# Function: appKitServingTypesPlugin()

```ts
function appKitServingTypesPlugin(options?: AppKitServingTypesPluginOptions): Plugin$1;
```

Vite plugin to generate TypeScript types for AppKit serving endpoints.
Fetches OpenAPI schemas from Databricks and generates a .d.ts with
ServingEndpointRegistry module augmentation.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | `AppKitServingTypesPluginOptions` |

## Returns

`Plugin$1`
