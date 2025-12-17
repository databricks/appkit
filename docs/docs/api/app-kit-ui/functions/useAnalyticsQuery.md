# Function: useAnalyticsQuery()

```ts
function useAnalyticsQuery<T, K>(
   queryKey, 
   parameters?, 
options?): UseAnalyticsQueryResult<InferResult<T, K>>;
```

Defined in: [packages/app-kit-ui/src/react/hooks/use-analytics-query.ts:70](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/use-analytics-query.ts#L70)

React hook for executing analytics queries with real-time updates via Server-Sent Events.

Provides automatic query execution, loading states, error handling, and HMR support
in development. The hook manages the SSE connection lifecycle and cleans up on unmount.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` | `unknown` |
| `K` *extends* `string` | `string` |

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `queryKey` | `K` | Query identifier matching a .sql file in your queries directory |
| `parameters?` | `InferParams`\<`K`\> \| `null` | Type-safe query parameters (inferred from QueryRegistry if available) |
| `options?` | [`UseAnalyticsQueryOptions`](../interfaces/UseAnalyticsQueryOptions.md) | Query execution options |

## Returns

[`UseAnalyticsQueryResult`](../interfaces/UseAnalyticsQueryResult.md)\<`InferResult`\<`T`, `K`\>\>

Query state object with data, loading, and error properties

## Examples

Basic query execution
```typescript
import { useAnalyticsQuery } from '@databricks/app-kit-ui';

function UserStats() {
  const { data, loading, error } = useAnalyticsQuery('user_stats', {
    userId: 123
  });

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;
  return <div>User: {data?.name}</div>;
}
```

Manual query execution
```typescript
import { useAnalyticsQuery } from '@databricks/app-kit-ui';

function DataExplorer() {
  const { data, loading, error, start } = useAnalyticsQuery(
    'complex_query',
    { filters: {...} },
    { autoStart: false }
  );

  return (
    <button onClick={start} disabled={loading}>
      Run Query
    </button>
  );
}
```
