---
sidebar_position: 3
---

# Analytics plugin

Enables SQL query execution against Databricks SQL Warehouses.

**Key features:**
- File-based SQL queries with automatic type generation
- Parameterized queries with type-safe [SQL helpers](../api/appkit/Variable.sql.md)
- JSON and Arrow format support
- Built-in caching and retry logic
- Server-Sent Events (SSE) streaming

## Basic usage

```ts
import { analytics, createApp, server } from "@databricks/appkit";

await createApp({
  plugins: [server(), analytics({})],
});
```

## Query files

- Put `.sql` files in `config/queries/`
- Query key is the filename without `.sql` (e.g. `spend_summary.sql` → `"spend_summary"`)

### Execution context

- `queryKey.sql` executes as **service principal** (shared cache)
- `queryKey.obo.sql` executes as **user** (OBO = on-behalf-of, per-user cache)

The execution context is determined by the SQL file name, not by the hook call.


## SQL parameters

Use `:paramName` placeholders and optionally annotate parameter types using SQL comments:

```sql
-- @param startDate DATE
-- @param endDate DATE
-- @param limit NUMERIC
SELECT ...
WHERE usage_date BETWEEN :startDate AND :endDate
LIMIT :limit
```

**Supported `-- @param` types** (case-insensitive):
- `STRING`, `NUMERIC`, `BOOLEAN`, `DATE`, `TIMESTAMP`, `BINARY`

## Server-injected parameters

`:workspaceId` is **injected by the server** and **must not** be annotated:

```sql
WHERE workspace_id = :workspaceId
```

## HTTP endpoints

The analytics plugin exposes these endpoints (mounted under `/api/analytics`):

- `POST /api/analytics/query/:query_key`
- `GET /api/analytics/arrow-result/:jobId`

## Format options

- `format: "JSON"` (default) returns JSON rows
- `format: "ARROW"` returns an Arrow "statement_id" payload over SSE, then the client fetches binary Arrow from `/api/analytics/arrow-result/:jobId`

## Frontend usage

### useAnalyticsQuery

React hook that subscribes to an analytics query over SSE and returns its latest result.

```ts
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";

const { data, loading, error } = useAnalyticsQuery(queryKey, parameters, options);
```

**Return type:**

```ts
{
  data: T | null;      // query result (typed array for JSON, TypedArrowTable for ARROW)
  loading: boolean;    // true while the query is executing
  error: string | null; // error message, or null on success
}
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `format` | `"JSON" \| "ARROW"` | `"JSON"` | Response format |
| `maxParametersSize` | `number` | `102400` | Max serialized parameters size in bytes |
| `autoStart` | `boolean` | `true` | Start query on mount |

**Example with loading/error/empty handling:**

```tsx
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { sql } from "@databricks/appkit-ui/js";
import { Skeleton } from "@databricks/appkit-ui";

function SpendTable() {
  const params = useMemo(() => ({
    startDate: sql.date("2025-01-01"),
    endDate: sql.date("2025-12-31"),
  }), []);

  const { data, loading, error } = useAnalyticsQuery("spend_summary", params);

  if (loading) return <Skeleton className="h-32 w-full" />;
  if (error) return <div className="text-destructive">{error}</div>;
  if (!data?.length) return <div className="text-muted-foreground">No results</div>;

  return (
    <ul>
      {data.map((row) => (
        <li key={row.id}>{row.name}: ${row.cost_usd}</li>
      ))}
    </ul>
  );
}
```

### Type-safe queries

Augment the `QueryRegistry` interface to get full type inference on parameters and results:

```ts
// config/appKitTypes.d.ts
declare module "@databricks/appkit-ui/react" {
  interface QueryRegistry {
    spend_summary: {
      name: "spend_summary";
      parameters: { startDate: string; endDate: string };
      result: Array<{ id: string; name: string; cost_usd: number }>;
    };
  }
}
```

See [Type generation](../development/type-generation.md) for automatic generation from SQL files.

### Memoization

**Always wrap parameters in `useMemo`** to avoid refetch loops. The hook re-executes whenever the parameters reference changes:

```ts
// Good
const params = useMemo(() => ({ status: sql.string("active") }), []);
const { data } = useAnalyticsQuery("users", params);

// Bad - creates a new object every render, causing infinite refetches
const { data } = useAnalyticsQuery("users", { status: sql.string("active") });
```
