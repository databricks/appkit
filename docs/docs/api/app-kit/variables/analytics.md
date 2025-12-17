# Variable: analytics

```ts
const analytics: ToPlugin<typeof AnalyticsPlugin, IAnalyticsConfig, "analytics">;
```

Defined in: [app-kit/src/analytics/analytics.ts:241](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/analytics/analytics.ts#L241)

Creates an analytics plugin instance for SQL query execution.

The analytics plugin provides:
- SQL query execution against Databricks SQL Warehouse
- Automatic caching of query results
- Type-safe query parameters
- User-scoped and service-scoped query endpoints
- Streaming query results via Server-Sent Events

Queries are loaded from `.sql` files in your query directory and can be
executed via HTTP endpoints with parameter substitution.

## Param

Analytics configuration options

## Param

Query execution timeout in milliseconds

## Param

Telemetry configuration for observability

## Returns

Plugin definition for use with createApp

## Examples

Basic analytics setup
```typescript
import { createApp, server, analytics } from '@databricks/app-kit';

const app = await createApp({
  plugins: [
    server(),
    analytics({})
  ]
});
```

Analytics with custom timeout
```typescript
import { createApp, analytics } from '@databricks/app-kit';

const app = await createApp({
  plugins: [
    analytics({
      timeout: 60000 // 60 seconds
    })
  ]
});
```
