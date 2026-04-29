---
sidebar_position: 4
---

# Analytics — Metric Views

UC Metric View consumption built on top of the analytics plugin: declarative metric registration, a typed React hook, structured filters, time-grain truncation, and library-agnostic format utilities.

**Key features:**
- Declarative `metric.json` config with `sp` and `obo` execution lanes
- `useMetricView` React hook with measure/dimension narrowing at the call site
- Structured filter spec — 12 operators, AND/OR composition, schema-validated members
- Time-grain truncation on time-typed dimensions
- Build-time semantic metadata bundle + library-agnostic format utilities
- `npx appkit metric sync` CLI for non-Vite builds, CI checks, pre-commit hooks
- OBO row scoping with cross-user cache isolation

The metric-view path lives inside the existing analytics plugin — apps without `metric.json` pay no bundle or runtime cost. See the [Analytics plugin](./analytics.md) for the underlying SQL execution machinery.

## Configuration: `metric.json`

Place a `metric.json` file alongside your `.sql` query files:

```json title="config/queries/metric.json"
{
  "$schema": "https://databricks.github.io/appkit/schemas/metric-source.schema.json",
  "sp": {
    "revenue": {
      "source": "appkit_demo.public.revenue_metrics"
    }
  },
  "obo": {
    "customer_metrics": {
      "source": "appkit_demo.public.customer_metrics"
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sp` | `Record<string, MetricEntry>` | Metrics executed as the service principal — shared cache. |
| `obo` | `Record<string, MetricEntry>` | Metrics executed on-behalf-of the requesting user — per-user cache. |
| `<key>.source` | `string` | Three-part Unity Catalog FQN of the metric view (`<catalog>.<schema>.<metric_view>`). |

The map key (`revenue`, `customer_metrics`) is the **single identity** that flows through every other surface: the route key in `POST /api/analytics/metric/:key`, the hook argument in `useMetricView("<key>", ...)`, the `MetricRegistry` augmentation key, and the cache-key segment.

The entry-object shape (`{ source }` at v1) is the forward-compat seam — future per-entry options (`cacheTtl`, `defaultFilter`, allowlists) grow non-breakingly. v1 deliberately rejects unknown fields.

The [JSON Schema](https://databricks.github.io/appkit/schemas/metric-source.schema.json) ships with AppKit; configure your IDE to validate `metric.json` against it.

## HTTP endpoint

The analytics plugin exposes one new endpoint (mounted under `/api/analytics`):

- `POST /api/analytics/metric/:key`

The Arrow secondary path (`GET /api/analytics/arrow-result/:jobId`) is reused unchanged.

### Request body

```ts
{
  measures: string[];                 // Required. Subset of declared measures.
  dimensions?: string[];              // Optional. Subset of declared dimensions.
  filter?: Filter;                    // Optional. Recursive AND/OR/Predicate tree.
  timeGrain?: string;                 // Optional. Applies to time-typed dimensions.
  limit?: number;                     // Optional. Row cap.
  format?: "JSON";                    // Optional. ARROW deferred to a future release.
}
```

### Response envelope

The route emits the same SSE event shape as `/api/analytics/query/:query_key`:

| Event | Description |
|-------|-------------|
| `result` | Final result payload (JSON rows). |
| `arrow` | Reserved — ARROW format is out of scope at v1. |
| `error` | Error event with `code` + `message`. |
| `warning` | Non-fatal advisory (e.g., row cap applied). |

## Frontend usage

### `useMetricView`

```ts
import { useMetricView } from "@databricks/appkit-ui/react";

const { data, metadata, loading, error } = useMetricView(metricKey, args, options);
```

Signature:

```ts
function useMetricView<
  K extends MetricKey,
  M extends ReadonlyArray<MeasureKey<K>>,
  D extends ReadonlyArray<DimensionKey<K>>,
  F extends AnalyticsFormat = "JSON",
>(
  metricKey: K,
  args: {
    measures: M;
    dimensions?: D;
    filter?: Filter<K>;
    timeGrain?: TimeGrain<K>;
    limit?: number;
  },
  options?: {
    format?: F;
    autoStart?: boolean;
    maxParametersSize?: number;
  },
): {
  data: Pick<MetricRow<K>, M[number] | D[number]>[] | null;
  metadata: MetricMetadata<K> | null;
  loading: boolean;
  error: string | null;
};
```

**Generic narrowing:**
- `K` narrows to a registered metric key when `MetricRegistry` is augmented.
- `M` and `D` carry `const` modifiers — pass `as const` on the arrays to preserve literal types.
- The result row type is `Pick<MetricRow<K>, M[number] | D[number]>` — the IDE shows exactly the columns you projected.

**Return shape:**

| Field | Type | Description |
|-------|------|-------------|
| `data` | Row array \| `null` | Picked-down rows once the query completes. |
| `metadata` | `MetricMetadata<K>` \| `null` | Build-time metadata for the queried metric (measures + dimensions). Available **before** `data` loads; stable across re-renders. |
| `loading` | `boolean` | `true` while the request is in flight. |
| `error` | `string \| null` | Error message; `null` on success. |

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `format` | `"JSON"` | `"JSON"` | Response format. ARROW deferred. |
| `autoStart` | `boolean` | `true` | Fire the request on mount. |
| `maxParametersSize` | `number` | `102400` | Max serialized request body size in bytes. |

**Example:**

```tsx
import { useMetricView } from "@databricks/appkit-ui/react";
import { useMemo } from "react";

function RevenueChart() {
  const args = useMemo(
    () =>
      ({
        measures: ["arr"] as const,
        dimensions: ["region", "created_at"] as const,
        timeGrain: "month" as const,
      }) as const,
    [],
  );

  const { data, metadata, loading, error } = useMetricView("revenue", args);

  if (loading) return <Skeleton />;
  if (error) return <ErrorBanner message={error} />;
  if (!data?.length) return <Empty />;

  // data: Array<{ arr: number; region: string; created_at: string }>
  // metadata.measures.arr.format → "$#,##0.00"
  // metadata.measures.arr.display_name → "Annual Recurring Revenue"
  return <Plot data={...} layout={...} />;
}
```

:::tip Memoize args

Wrap the `args` object in `useMemo` so reference stability prevents infinite refetches — the hook re-fires whenever the args reference changes, mirroring `useAnalyticsQuery`.
:::

### Type-safe registration

The build-time pipeline augments the `MetricRegistry` interface declared in `@databricks/appkit-ui/react`. The generated `metrics.d.ts` looks like:

```ts
declare module "@databricks/appkit-ui/react" {
  interface MetricRegistry {
    revenue: {
      key: "revenue";
      source: "appkit_demo.public.revenue_metrics";
      lane: "sp";
      measures: { arr: number; mrr: number };
      dimensions: { region: string; created_at: string };
      measureKeys: "arr" | "mrr";
      dimensionKeys: "region" | "created_at";
      timeGrains: "day" | "week" | "month";
      metadata: {
        measures: {
          arr: {
            type: "DECIMAL(38,2)";
            display_name: "Annual Recurring Revenue";
            format: "$#,##0.00";
          };
        };
        dimensions: {
          region: { type: "STRING" };
          created_at: {
            type: "TIMESTAMP";
            time_grain: readonly ["day", "week", "month"];
          };
        };
      };
    };
  }
}
```

Once augmented, `useMetricView("revenue", { measures: ["arr"] })` autocompletes measure names, rejects typos at compile time, and narrows the result row type at the call site.

## Filter spec

The structured filter is a recursive type:

```ts
type Filter<K> =
  | Predicate<K>
  | { and: ReadonlyArray<Filter<K>> }
  | { or: ReadonlyArray<Filter<K>> };

interface Predicate<K> {
  member: DimensionKey<K>;
  operator: MetricFilterOperator;
  values?: ReadonlyArray<string | number>;
}
```

The 12 v1 operators:

| Category | Operators | Cardinality | Notes |
|----------|-----------|-------------|-------|
| Equality | `equals`, `notEquals` | exactly one value | Any dimension type. |
| Set membership | `in`, `notIn` | one or more values | Any dimension type. |
| Range | `gt`, `gte`, `lt`, `lte` | exactly one value | Numeric / date-typed dimensions only. |
| String search | `contains`, `notContains` | exactly one value | String-typed dimensions only. |
| NULL checks | `set`, `notSet` | no values (rejected if present) | Any dimension type. |

`startsWith`, `endsWith`, `between`, and date-range helpers are reserved for v1.5.

### Examples

**Single predicate:**

```ts
filter: { member: "region", operator: "in", values: ["EMEA", "APAC"] }
```

**Implicit AND (predicate list inside an `and` group):**

```ts
filter: {
  and: [
    { member: "region", operator: "in", values: ["EMEA"] },
    { member: "segment", operator: "equals", values: ["Enterprise"] },
  ],
}
```

**Nested OR:**

```ts
filter: {
  or: [
    {
      and: [
        { member: "region", operator: "equals", values: ["EMEA"] },
        { member: "segment", operator: "equals", values: ["Enterprise"] },
      ],
    },
    { member: "region", operator: "equals", values: ["APAC"] },
  ],
}
```

**NULL check:**

```ts
filter: { member: "csm_email", operator: "set" }
```

The server enforces:
- `member` is a registered dimension on the metric (typos return 400).
- `operator` is one of the 12 v1 names.
- Operator-vs-type compatibility (e.g., `gt` on a string dimension returns 400).
- `values` cardinality matches the operator.
- Recursion depth ≤ 8 (defense against malformed payloads).
- All values bind as parameters via the Statement Execution bind-var path — **no value from the request body flows into the rendered SQL string**.

## Time grain

`timeGrain` is a single optional top-level field on the request body. When set, it applies to every time-typed dimension in `dimensions`:

```ts
useMetricView("revenue", {
  measures: ["arr"] as const,
  dimensions: ["created_at"] as const,
  timeGrain: "month",
});
```

Generated SQL:

```sql
SELECT date_trunc('month', created_at) AS created_at, MEASURE(arr) AS arr
FROM appkit_demo.public.revenue_metrics
GROUP BY ALL
```

The `TimeGrain<K>` type narrows to the union of grains the metric view's YAML 1.1 `time_grain` attribute declares. Setting `timeGrain` without including a time-typed dimension in `dimensions` returns 400 with `timeGrain specified but no time-typed dimension grouped`.

Date ranges are expressed via the structured filter spec (`gte`/`lte` predicates on the time dimension), not a separate `dateRange` field.

## Semantic metadata + format utilities

Build-time, the type-generator emits `metrics.metadata.json` alongside the typed `.d.ts`:

```json
{
  "revenue": {
    "source": "appkit_demo.public.revenue_metrics",
    "lane": "sp",
    "measures": {
      "arr": {
        "type": "DECIMAL(38,2)",
        "display_name": "Annual Recurring Revenue",
        "format": "$#,##0.00",
        "description": "Annualized contract value across active subscriptions"
      }
    },
    "dimensions": {
      "created_at": {
        "type": "TIMESTAMP",
        "display_name": "Subscription Start",
        "time_grain": ["day", "week", "month"]
      }
    }
  }
}
```

Register the bundle once at app startup:

```ts title="src/main.tsx"
import { registerMetricsMetadata } from "@databricks/appkit-ui/format";
import metricsMetadata from "../shared/appkit-types/metrics.metadata.json";

registerMetricsMetadata(metricsMetadata);
```

`useMetricView` then returns the relevant subset (measures + dimensions for the queried metric) in `metadata`. The reference is stable across re-renders for the same metric key.

### Library-agnostic format utilities

Three pure functions in `@databricks/appkit-ui/format`:

```ts
import { formatLabel, formatValue, toD3Format } from "@databricks/appkit-ui/format";
```

| Function | Signature | Purpose |
|----------|-----------|---------|
| `formatValue(value, format?)` | `(value, format?) => string` | Turns a raw value + UC format spec into a display string. |
| `formatLabel(name, columnMetadata?)` | `(name, columnMetadata?) => string` | Returns `display_name` or humanizes the column name. |
| `toD3Format(format?)` | `(format?) => string` | Converts a UC printf-style spec to a d3-format-compatible string. |

Recognized format specs (passthrough — UC's YAML 1.1 emits printf-style strings, AppKit forwards them):

| YAML format | `formatValue(1234.56, ...)` | `toD3Format(...)` |
|-------------|----------------------------|-------------------|
| `$#,##0.00` | `"$1,234.56"` | `"$,.2f"` |
| `0.00%` | `"123,456.00%"` (use `0.0%` for ratios) | `".2%"` |
| `0.0%` | `"42.7%"` (input `0.427`) | `".1%"` |
| `#,##0` | `"1,235"` | `",.0f"` |
| `0.000` | `"1234.560"` | `".3f"` |
| (omitted) | localized number formatting | `""` (let chart use defaults) |

### Plotly example

```tsx
import { formatLabel, toD3Format } from "@databricks/appkit-ui/format";
import { useMetricView } from "@databricks/appkit-ui/react";
import Plot from "react-plotly.js";

function ARRChart() {
  const { data, metadata } = useMetricView("revenue", {
    measures: ["arr"] as const,
    dimensions: ["created_at"] as const,
    timeGrain: "month",
  });

  if (!data || !metadata) return null;

  return (
    <Plot
      data={[
        {
          type: "scatter",
          mode: "lines+markers",
          name: formatLabel("arr", metadata.measures.arr),
          x: data.map((row) => row.created_at),
          y: data.map((row) => row.arr),
        },
      ]}
      layout={{
        title: { text: formatLabel("arr", metadata.measures.arr) },
        yaxis: { tickformat: toD3Format(metadata.measures.arr.format) },
      }}
    />
  );
}
```

### ECharts example

```tsx
import { formatLabel, toD3Format } from "@databricks/appkit-ui/format";
import { useMetricView } from "@databricks/appkit-ui/react";
import ReactECharts from "echarts-for-react";

function ARRChart() {
  const { data, metadata } = useMetricView("revenue", {
    measures: ["arr"] as const,
    dimensions: ["created_at"] as const,
    timeGrain: "month",
  });

  if (!data || !metadata) return null;

  return (
    <ReactECharts
      option={{
        title: { text: formatLabel("arr", metadata.measures.arr) },
        xAxis: { type: "category", data: data.map((r) => r.created_at) },
        yAxis: {
          type: "value",
          axisLabel: {
            // ECharts accepts a d3-format-compatible string via formatter,
            // or a function form for full control.
            formatter: toD3Format(metadata.measures.arr.format),
          },
        },
        series: [
          {
            type: "line",
            data: data.map((r) => r.arr),
            name: formatLabel("arr", metadata.measures.arr),
          },
        ],
      }}
    />
  );
}
```

The format utilities are deliberately library-agnostic — they emit strings the consumer's chart library decides how to consume. Wrapping a specific chart-library API is glue customers can write in tens of lines, not the framework's responsibility.

## CLI

```bash
npx appkit metric sync
```

The `metric sync` subcommand calls the same `syncMetrics()` core that the Vite type-generator runs in dev mode. Useful for:

- CI checks (verify generated types are committed and match the warehouse).
- Non-Vite builds (Webpack, Rspack, Turbopack, raw `tsc`).
- Manual refresh after a teammate's `metric.json` change.
- Pre-commit hooks.

Flags:

| Flag | Description |
|------|-------------|
| `--warehouse-id <id>` | Override the default warehouse. |
| `--metric-json-path <path>` | Override the default `config/queries/metric.json` location. |
| `--output-dir <dir>` | Override where the generated `metrics.d.ts` and `metrics.metadata.json` land. |
| `--silent` | Suppress non-error output. |

The CLI exits with:
- `0` on success.
- Non-zero with a recognizable message for missing FQN, unreachable warehouse, malformed `metric.json`, or schema-fetch authentication failure.

Future subcommands (`list`, `validate`, `describe`) plug into the same parent command.

## Security model

The metric-view path inherits AppKit's plugin-best-practices defaults and adds a few metric-specific reinforcements:

1. **Validator-first.** Every column name (`measures`, `dimensions`, filter `member`) is checked against the build-time schema snapshot before SQL construction. **No user-supplied string is ever interpolated into the generated SQL.** Unknown columns return 400.

2. **Operator allowlist.** The 12 v1 operator names are an exhaustive enum — any other string in `operator` returns 400.

3. **Operator-vs-type compatibility.** `gt` on a string dim returns 400. `contains` on a numeric dim returns 400. The validator is the source of truth.

4. **Parameterized values.** Every value in a predicate is bound as a parameter via the Statement Execution bind-var path. SQL injection via filter values is structurally impossible.

5. **Recursion depth cap.** AND/OR nesting is limited to 8 levels — defense against stack-abuse via hostile payloads.

6. **OBO row scoping.** Entries in the `obo` lane dispatch via the `asUser(req)` Proxy, threading the user's `x-forwarded-access-token` through every Databricks call. The warehouse executes the query under the end-user's identity.

7. **Cross-user cache isolation.** OBO cache keys take the form `metric:{key}:{argsHash}:{sha256(userIdentity)}`. The raw email/principal name never reaches the cache layer. SP-lane keys use literal `"sp"` as the executor key — shared cache by design.

8. **Sort-before-hash on order-insensitive args.** Measures, dimensions, and filter predicates within each AND/OR group are stable-sorted before hashing, so semantically equivalent calls collapse to the same cache entry.

The server emits four metric-specific telemetry spans: `analytics.metric.query`, `analytics.metric.validate`, `analytics.metric.cache.hit`, `analytics.metric.cache.miss`. Metrics: `metric_query_duration_seconds`, `metric_cache_hit_ratio`, `metric_validation_failures_total`.

## Migration from hand-rolled metric SQL

If you previously consumed metric views by hand-writing SQL with `MEASURE(...)` in `.sql` files:

```sql title="config/queries/revenue.sql (legacy approach)"
SELECT
  date_trunc(:grain, created_at) AS created_at,
  region,
  MEASURE(arr) AS arr
FROM appkit_demo.public.revenue_metrics
WHERE region IN (:r1, :r2)
GROUP BY ALL
```

Migrate by:

1. **Move the FQN into `metric.json`** under `sp` or `obo`:

   ```json title="config/queries/metric.json"
   {
     "sp": {
       "revenue": { "source": "appkit_demo.public.revenue_metrics" }
     }
   }
   ```

2. **Replace `useAnalyticsQuery` with `useMetricView`** at the call site:

   ```tsx
   // Before
   const { data } = useAnalyticsQuery("revenue", {
     grain: sql.string("month"),
     r1: sql.string("EMEA"),
     r2: sql.string("APAC"),
   });

   // After
   const { data, metadata } = useMetricView("revenue", {
     measures: ["arr"] as const,
     dimensions: ["region", "created_at"] as const,
     timeGrain: "month",
     filter: {
       member: "region",
       operator: "in",
       values: ["EMEA", "APAC"],
     },
   });
   ```

3. **Delete the `.sql` file.** The server constructs SQL deterministically from the structured args.

4. **Run `npx appkit metric sync`** (or rely on the Vite plugin) to regenerate `metrics.d.ts` and `metrics.metadata.json`. The `MetricRegistry` augmentation lights up call-site narrowing.

5. **Optional: wire metadata into your chart.** Use `formatLabel` / `formatValue` / `toD3Format` to consume the YAML's `display_name` and `format` instead of re-typing them in TypeScript.

The metric-view path is purely additive — your other `.sql` files keep working unchanged. Apps that don't use metric views never load `useMetricView` or the format utilities.

## Out of scope at v1

- **ARROW format.** v1 is JSON-only; metric-view results are typically aggregated and small.
- **Per-entry growth options** (`cacheTtl`, `defaultFilter`, `dimensions` allowlist).
- **Filter ops beyond v1** (`startsWith`, `endsWith`, `between`, date-range family).
- **HAVING (filtering on measures).** v1 restricts `member` to dimensions.
- **Runtime schema refresh.** Build-time only; deploys reset the snapshot.
- **Metric view CRUD.** Read-only consumption at v1.
- **Auto-discovery from UC.** Explicit declaration in `metric.json` is required.
- **Multi-view joins.** One query targets one metric view.
- **Chart-library adapters.** Format utilities are the framework's contribution; chart wrapping is glue customers write in tens of lines.

Each of these is a non-breaking additive change when concrete demand arrives.
