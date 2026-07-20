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

### Sample values for type generation

Some queries only have a valid shape once a parameter has a concrete value — most
commonly a dynamic table name built with `IDENTIFIER()`. During type generation
AppKit runs `DESCRIBE QUERY` with placeholder defaults, so an unresolved parameter
collapses to an empty string and produces invalid SQL
(`IDENTIFIER('' || '.schema.table')` → `PARSE_SYNTAX_ERROR`).

Append `= value` to a `-- @param` annotation to give type generation a sample
value. It is used **only** while describing the query; at runtime the real
parameter is still bound, so the query stays portable across environments:

```sql
-- @param target_catalog STRING = main
SELECT *
FROM IDENTIFIER(:target_catalog || '.sales.nation')
```

Type generation describes `main.sales.nation` to infer the result columns, while
the deployed app binds whatever catalog the caller passes. String, `DATE`, and
`TIMESTAMP` values are quoted automatically (`= main` → `'main'`), and an
already-quoted literal is kept as-is (`= '2024-01-01'`). Numeric, `BOOLEAN`, and
`BINARY` values are validated against a strict literal shape (`= 100`, `= true`,
`= X'00'`); a value that doesn't match — anything that could otherwise inject SQL
into the describe statement — is ignored and the parameter falls back to its
type-based placeholder, so a sample value can never break out of the
`DESCRIBE QUERY`.

## Server-injected parameters

`:workspaceId` is **injected by the server** and **must not** be annotated:

```sql
WHERE workspace_id = :workspaceId
```

## HTTP endpoints

The analytics plugin exposes these endpoints (mounted under `/api/analytics`):

- `POST /api/analytics/query/:query_key`
- `GET /api/analytics/arrow-result/:jobId`
- `POST /api/analytics/metric/:key` — measure a Unity Catalog Metric View (see [Metric views](#metric-views))

## Format options

- `format: "JSON"` (default) returns JSON rows
- `format: "ARROW"` returns an Arrow "statement_id" payload over SSE, then the client fetches binary Arrow from `/api/analytics/arrow-result/:jobId`

## Metric views

`POST /api/analytics/metric/:key` measures a [Unity Catalog Metric View](https://docs.databricks.com/en/metric-views/index.html) that you declared in `config/queries/metric-views.json`. Instead of writing SQL, the caller sends a structured request — which measures to aggregate, which dimensions to group by, and an optional filter — and the plugin builds and runs the `SELECT MEASURE(...) ... GROUP BY ALL` for you against the view.

The route is **dormant until `metric-views.json` exists**: with no config file, every metric key returns `404`. Declaring the file (and generating types) is covered in [Metric-view types](../development/type-generation.md#metric-view-types); this section documents the runtime endpoint that config activates.

### Request body

```
POST /api/analytics/metric/:key
Content-Type: application/json

{
  "measures": ["arr", "revenue"],
  "dimensions": ["region", "order_date"],
  "timeGrain": "month",
  "timeDimension": "order_date",
  "filter": { "member": "region", "operator": "in", "values": ["EMEA", "APAC"] },
  "limit": 100
}
```

`:key` is a metric key from `metric-views.json`. The body fields:

| Field           | Type       | Required | Description                                                                                                  |
| --------------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `measures`      | `string[]` | yes      | Measures to aggregate. At least 1, at most 50. Each becomes `MEASURE(<name>) AS <name>`.                     |
| `dimensions`    | `string[]` | no       | Dimensions to group by (max 20). Selected verbatim and grouped via `GROUP BY ALL`.                           |
| `filter`        | object     | no       | Structured predicate tree translated into a parameterized `WHERE` clause (see [Filters](#filters)).          |
| `timeGrain`     | `string`   | no       | Bucket a time dimension via `date_trunc('<grain>', …)` — e.g. `day`, `month`. Requires `timeDimension`.      |
| `timeDimension` | `string`   | no       | The single dimension `timeGrain` buckets. Must be one of `dimensions`. Required whenever `timeGrain` is set. |
| `limit`         | `number`   | no       | Positive integer row cap (max 100000).                                                                       |
| `format`        | `string`   | no       | `JSON_ARRAY` (default). `JSON` is accepted as a deprecated alias for it; Arrow formats (`ARROW`, `ARROW_STREAM`) are rejected on this route. |

Measures and dimensions must be unique across both lists — a name cannot repeat, nor appear as both a measure and a dimension.

### How the request becomes SQL

Given a view registered as `catalog.schema.revenue_metrics`, the request above produces (measures and dimensions are sorted for a deterministic SELECT list):

```sql
SELECT MEASURE(`arr`) AS `arr`, MEASURE(`revenue`) AS `revenue`,
       date_trunc('month', `order_date`) AS `order_date`, `region`
FROM `catalog`.`schema`.`revenue_metrics`
WHERE `region` IN (:f_0, :f_1)
GROUP BY ALL
LIMIT 100
```

The metric view's FQN and every measure/dimension identifier are backtick-quoted; filter values are bound as parameters (`:f_0`, `:f_1`, …), never interpolated into the SQL string.

### Filters

`filter` is a recursive tree. A leaf is a single predicate:

```json
{ "member": "region", "operator": "equals", "values": ["EMEA"] }
```

Predicates combine with `and` / `or` groups, which can nest:

```json
{
  "and": [
    { "member": "region", "operator": "in", "values": ["EMEA", "APAC"] },
    {
      "or": [
        { "member": "segment", "operator": "equals", "values": ["Enterprise"] },
        { "member": "deal_size", "operator": "gt", "values": [50000] }
      ]
    }
  ]
}
```

The operator vocabulary:

| Operator                    | SQL                     | Values             |
| --------------------------- | ----------------------- | ------------------ |
| `equals`                    | `=`                     | exactly one        |
| `notEquals`                 | `<>`                    | exactly one        |
| `in`                        | `IN (…)`                | one or more        |
| `notIn`                     | `NOT IN (…)`            | one or more        |
| `gt` / `gte` / `lt` / `lte` | `>` / `>=` / `<` / `<=` | exactly one        |
| `contains`                  | `LIKE :param`           | exactly one string |
| `notContains`               | `NOT LIKE :param`       | exactly one string |
| `set`                       | `IS NOT NULL`           | none               |
| `notSet`                    | `IS NULL`               | none               |

For `contains` / `notContains`, the `%…%` wildcards are applied to the *bound parameter value* (`%value%`), not written into the SQL text — so the value is never interpolated, consistent with every other operator.

An empty `or` group (`{ "or": [] }`) is rejected with `400`; an empty `and` group (`{ "and": [] }`) is accepted and contributes no `WHERE` clause (a no-op). Keep this in mind when building filter trees programmatically.

Filters are bounded to keep hostile input from exhausting the server: nesting depth ≤ 8, ≤ 100 children per `and` / `or` group, and ≤ 1000 values per predicate. A request that exceeds a cap is rejected with `400`.

### Executors (cache scope)

Each entry in `metric-views.json` names the executor the query runs as, which also sets the cache scope. This is fixed by config, not the request:

| `executor`                        | Runs as                            | Cache                   |
| --------------------------------- | ---------------------------------- | ----------------------- |
| `app_service_principal` (default) | The app service principal          | Shared across all users |
| `user`                            | The requesting user (on-behalf-of) | Per user                |

This mirrors the `<key>.sql` vs `<key>.obo.sql` distinction for [file-based queries](#execution-context).

### Response

The response is the same SSE stream as `POST /api/analytics/query/:query_key`. If the SQL warehouse is cold it first emits `warehouse_status` events (see [Warehouse readiness](#warehouse-readiness)), then a single `result` event with the rows as objects:

```json
{
  "type": "result",
  "data": [
    {
      "region": "EMEA",
      "order_date": "2025-01-01",
      "arr": 1200000,
      "revenue": 340000
    }
  ]
}
```

On failure it emits an `error` event instead.

### Errors and behavior

| Status | Body                                                                                  | When                                                                                                             |
| ------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `404`  | `{ "error": "Metric not found" }`                                                     | `:key` is not declared in `metric-views.json` (also the response for every key when the file is absent).         |
| `400`  | `{ "error": "Invalid metric request body (fields: …)", "code": … }`                   | The request body fails validation. The message names only the offending field paths, never the submitted values. |
| `503`  | `{ "error": "Metric registry not available", "code": "METRIC_REGISTRY_LOAD_FAILED" }` | `metric-views.json` is present but malformed or unreadable.                                                      |

Editing `metric-views.json` is picked up on the next request — no server restart is needed. A previously malformed file that you fix likewise starts working on the next request.

## Frontend usage

### useAnalyticsQuery

React hook that subscribes to an analytics query over SSE and returns its latest result.

```ts
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";

const { data, loading, error } = useAnalyticsQuery(
  queryKey,
  parameters,
  options,
);
```

**Return type:**

```ts
{
  data: T | null; // query result (typed array for JSON, TypedArrowTable for ARROW)
  loading: boolean; // true while the query is executing
  error: string | null; // error message, or null on success
  warehouseStatus: WarehouseStatus | null; // see "Warehouse readiness" below
}
```

**Options:**

| Option              | Type                | Default  | Description                             |
| ------------------- | ------------------- | -------- | --------------------------------------- |
| `format`            | `"JSON" \| "ARROW"` | `"JSON"` | Response format                         |
| `maxParametersSize` | `number`            | `102400` | Max serialized parameters size in bytes |
| `autoStart`         | `boolean`           | `true`   | Start query on mount                    |

### Warehouse readiness

If the configured SQL warehouse is `STOPPED` or `STARTING` when a query is requested, the analytics plugin will:

1. Auto-start the warehouse (when `STOPPED`).
2. Poll the warehouse state and stream `warehouse_status` events over SSE until it reaches `RUNNING`.
3. Execute the SQL statement.

This means a cold start no longer freezes the UI on a stalled spinner. Render the new `warehouseStatus` field to give users feedback:

```tsx
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";

function SpendTable() {
  const { data, loading, error, warehouseStatus } = useAnalyticsQuery(
    "spend_summary",
    params,
  );

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
import { useResourceStatusToaster, Toaster } from "@databricks/appkit-ui/react";

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
      {agg.worst?.kind} {agg.worst?.state.toLowerCase()} ({agg.activeCount}{" "}
      waiting)
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
      description: (_s, agg) => `${agg.affectedLabels.length} chart(s) waiting`,
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
  const { publish, unpublish } = useResourceStatusPublisher(id, "lakebase", {
    kindHint: "lakebase",
  });

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

| Option                      | Type      | Default          | Description                                                                                                                                                                                                                                               |
| --------------------------- | --------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warehouseStartupTimeoutMs` | `number`  | `300000` (5 min) | Maximum time to wait for the warehouse to reach `RUNNING` before failing the request                                                                                                                                                                      |
| `autoStartWarehouse`        | `boolean` | `true`           | When `true`, a `STOPPED` warehouse is auto-started on the first request. Set to `false` for cost-controlled deployments where billable warehouse starts must not be triggered by user requests; in that case `STOPPED` surfaces as a `ConfigurationError` |

**Example with loading/error/empty handling:**

```tsx
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { sql } from "@databricks/appkit-ui/js";
import { Skeleton } from "@databricks/appkit-ui";

function SpendTable() {
  const params = useMemo(
    () => ({
      startDate: sql.date("2025-01-01"),
      endDate: sql.date("2025-12-31"),
    }),
    [],
  );

  const { data, loading, error } = useAnalyticsQuery("spend_summary", params);

  if (loading) return <Skeleton className="h-32 w-full" />;
  if (error) return <div className="text-destructive">{error}</div>;
  if (!data?.length)
    return <div className="text-muted-foreground">No results</div>;

  return (
    <ul>
      {data.map((row) => (
        <li key={row.id}>
          {row.name}: ${row.cost_usd}
        </li>
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
