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
-- @param limit INT
SELECT ...
WHERE usage_date BETWEEN :startDate AND :endDate
LIMIT :limit
```

`LIMIT` / `OFFSET` require Spark `IntegerType` specifically — `BIGINT`
(`LongType`) is rejected with `INVALID_LIMIT_LIKE_EXPRESSION.DATA_TYPE`.
Annotate with `INT`, or use `sql.number()` (auto-infers `INT` for values in
`[-2^31, 2^31-1]`, falling back to `BIGINT` for wider values) / `sql.int()`
at the call site.

**Supported `-- @param` types** (case-insensitive):
- `STRING`, `BOOLEAN`, `DATE`, `TIMESTAMP`, `BINARY`
- `INT`, `BIGINT`, `TINYINT`, `SMALLINT` — bind via `sql.int()` / `sql.bigint()`
- `FLOAT`, `DOUBLE` — bind via `sql.float()` / `sql.double()`
- `NUMERIC`, `DECIMAL` — bind via `sql.numeric()` (pass strings for precision)

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
  warehouseStatus: WarehouseStatus | null; // see "Warehouse readiness" below
}
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `format` | `"JSON" \| "ARROW"` | `"JSON"` | Response format |
| `maxParametersSize` | `number` | `102400` | Max serialized parameters size in bytes |
| `autoStart` | `boolean` | `true` | Start query on mount |

### Warehouse readiness

If the configured SQL warehouse is `STOPPED` or `STARTING` when a query is requested, the analytics plugin will:

1. Auto-start the warehouse (when `STOPPED`).
2. Poll the warehouse state and stream `warehouse_status` events over SSE until it reaches `RUNNING`.
3. Execute the SQL statement.

This means a cold start no longer freezes the UI on a stalled spinner. Render the new `warehouseStatus` field to give users feedback:

```tsx
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";

function SpendTable() {
  const { data, loading, error, warehouseStatus } =
    useAnalyticsQuery("spend_summary", params);

  if (warehouseStatus && warehouseStatus.state !== "RUNNING") {
    return <div>Warehouse is {warehouseStatus.state.toLowerCase()}…</div>;
  }
  if (loading) return <div>Loading…</div>;
  if (error) return <div>{error}</div>;
  return <table>{/* render data */}</table>;
}
```

`warehouseStatus` is `null` until the first status event arrives. After the server has observed the warehouse `RUNNING` once, subsequent requests within ~30s skip the readiness check entirely and `warehouseStatus` stays `null`, so the steady-state hot path isn't taxed any extra round-trips.

If the warehouse is `DELETED`/`DELETING` or fails to reach `RUNNING` within the configured timeout, the route emits an `error` event (surfaced via the `error` field).

#### Global readiness indicator

For dashboards with many charts a per-component spinner isn't enough — wiring the same "warehouse warming up" UI into every skeleton is repetitive. AppKit ships a small generic context (`ResourceStatusProvider`) + drop-in indicator (`ResourceStatusIndicator`) that any plugin can publish into; analytics warehouses are wired up automatically.

The indicator surfaces the worst pending status as a [sonner](https://sonner.emilkowal.ski/) toast, so it inherits sonner's animations, theming, and stacking. The component mounts its own `<Toaster />` (top-right by default) and forwards its props (`position`, `theme`, `richColors`, …):

```tsx
import {
  ResourceStatusIndicator,
  ResourceStatusProvider,
} from "@databricks/appkit-ui/react";

export function AppShell({ children }) {
  return (
    <ResourceStatusProvider>
      <ResourceStatusIndicator />
      {children}
    </ResourceStatusProvider>
  );
}
```

`useAnalyticsQuery` registers itself with the nearest provider, so no per-chart wiring is needed. The indicator renders only the `<Toaster />` mount point while every resource is healthy; it pops a single sticky toast — `toast.loading` for cold starts, `toast.error` for unrecoverable states — keyed by the worst kind, and dismisses it when they all settle. Because the same provider is shared across resource kinds (warehouse, lakebase, model serving, …), a single indicator covers every plugin.

If you already render your own `<Toaster />` for unrelated app toasts, drop the indicator and call `useResourceStatusToaster()` instead so resource-status toasts share that single Toaster:

```tsx
import {
  useResourceStatusToaster,
  Toaster,
} from "@databricks/appkit-ui/react";

function App() {
  useResourceStatusToaster();
  return (
    <>
      <Toaster position="top-right" />
      <Routes />
    </>
  );
}
```

For a fully custom toast body, pass `render` (rendered through `toast.custom`):

```tsx
<ResourceStatusIndicator
  render={(agg) => (
    <div className="rounded-lg border bg-background p-3 shadow">
      {agg.worst?.kind} {agg.worst?.state.toLowerCase()} ({agg.activeCount} waiting)
    </div>
  )}
/>
```

To override copy for a specific kind without rewriting the whole UI, pass `renderers`:

```tsx
<ResourceStatusIndicator
  renderers={{
    warehouse: {
      title: () => "Spinning up your data",
      description: (_s, agg) =>
        `${agg.affectedLabels.length} chart(s) waiting`,
    },
  }}
/>
```

Or build your own UI from the aggregate with `useResourceStatus()`:

```ts
import { useResourceStatus } from "@databricks/appkit-ui/react";

// Worst across all kinds
const aggregate = useResourceStatus();
// Just warehouses
const warehouseOnly = useResourceStatus({ kind: "warehouse" });
// { worst, byKind, affectedLabels, activeCount, elapsedMs }
```

The provider is optional. Apps that don't mount it still get the per-hook `warehouseStatus` field and the hook works exactly as before.

##### Publishing your own resource status

Plugins (or your own code) can hook into the same provider for non-analytics resources — e.g. a Lakebase Postgres connection warming up, a model-serving endpoint cold-starting:

```ts
import { useResourceStatusPublisher } from "@databricks/appkit-ui/react";
import { useEffect, useId } from "react";

function useLakebaseReadiness() {
  const id = useId();
  const { publish, unpublish } = useResourceStatusPublisher(
    id,
    "lakebase",
    { kindHint: "lakebase" },
  );

  useEffect(() => {
    publish({
      kind: "lakebase",
      state: "STARTING",
      severity: "pending",
      startedAt: Date.now(),
    });
    return () => unpublish();
  }, [publish, unpublish]);
}
```

**Server config (in `analytics({...})`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `warehouseStartupTimeoutMs` | `number` | `300000` (5 min) | Maximum time to wait for the warehouse to reach `RUNNING` before failing the request |
| `autoStartWarehouse` | `boolean` | `true` | When `true`, a `STOPPED` warehouse is auto-started on the first request. Set to `false` for cost-controlled deployments where billable warehouse starts must not be triggered by user requests; in that case `STOPPED` surfaces as a `ConfigurationError` |

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
// shared/appkit-types/analytics.d.ts
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
