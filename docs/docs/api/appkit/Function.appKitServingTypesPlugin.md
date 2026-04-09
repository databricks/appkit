# Function: appKitServingTypesPlugin()

```ts
function appKitServingTypesPlugin(options?: AppKitServingTypesPluginOptions): Plugin$1;
```

Vite plugin to generate TypeScript types for AppKit serving endpoints.
Fetches OpenAPI schemas from Databricks and generates a .d.ts with
ServingEndpointRegistry module augmentation.

Endpoint discovery order:
1. Explicit `endpoints` option (override)
2. AST extraction from server file (server/index.ts or server/server.ts)
3. DATABRICKS_SERVING_ENDPOINT_NAME env var (single default endpoint)

## Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | `AppKitServingTypesPluginOptions` |

## Returns

`Plugin$1`
