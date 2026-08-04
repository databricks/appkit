---
sidebar_position: 5
---

# Type generation

AppKit can automatically generate TypeScript types for your SQL queries, providing end-to-end type safety from database to UI.

## Goal

Generate type-safe TypeScript declarations for query keys, parameters, and result rows.

All generated files live in `shared/appkit-types/`, one per concern: `analytics.d.ts` (SQL query types), `serving.d.ts` (model-serving endpoint types), and `metric-views.ts`. A single command (and the Vite plugin) produces them all in one pass; see [Metric-view types](#metric-view-types). The declaration files use [`declare module`](https://www.typescriptlang.org/docs/handbook/declaration-merging.html#module-augmentation) to augment existing interfaces, so the types apply globally — you never need to import them. (`metric-views.ts` is a real source file rather than a `.d.ts` because it *also* carries a runtime `metricViewsMetadata` constant alongside the augmentation — see [Metric-view types](#metric-view-types).) TypeScript auto-discovers them through `"include": ["shared/appkit-types"]` in your tsconfig.

## Vite plugin: `appKitTypesPlugin`

The recommended approach is to use the Vite plugin, which watches your SQL files and regenerates types automatically during development.

### Configuration

- `outFile?: string` - Output file path (default: `shared/appkit-types/analytics.d.ts`)
- `watchFolders?: string[]` - Folders to watch for SQL files (default: `["../config/queries"]`)

### Example

```ts
// client/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { appKitTypesPlugin } from "@databricks/appkit";

export default defineConfig({
  plugins: [
    react(),
    appKitTypesPlugin({
      watchFolders: ["../config/queries"],
    }),
  ],
});
```

### Important nuance

When the frontend is served through AppKit in dev mode, AppKit's dev server already includes `appKitTypesPlugin()` internally. You still want it in your client build pipeline if you run `vite build` separately.

## CLI: `npx @databricks/appkit generate-types`

For manual type generation or CI/CD pipelines, use the CLI command:

```bash
# Requires DATABRICKS_WAREHOUSE_ID (or pass as 3rd arg)
npx @databricks/appkit generate-types [rootDir] [outFile] [warehouseId]
```

### Examples

- Generate types using warehouse ID from environment

  ```bash
  npx @databricks/appkit generate-types . shared/appkit-types/analytics.d.ts
  ```

- Generate types using warehouse ID explicitly

  ```bash
  npx @databricks/appkit generate-types . shared/appkit-types/analytics.d.ts abc123...
  ```

- Force regeneration (skip cache)

  ```bash
  npx @databricks/appkit generate-types --no-cache
  ```

### Warehouse readiness and the `--wait` flag

By default, `generate-types` is **non-blocking**: it never waits on — or fails because of — your SQL warehouse. It writes the best types it can immediately (reusing cached types where the query is unchanged, otherwise `result: unknown`) and then spawns a detached background worker that refreshes the real types once the warehouse is ready. This keeps `npm install` (postinstall) and `npm run dev` (predev) fast and resilient to a cold or briefly-unreachable warehouse. The dev Vite plugin behaves the same way: types appear instantly and refresh in place once the warehouse is live.

Pass `--wait` for CI and production builds, where accurate types must be present before the build proceeds:

```bash
npx @databricks/appkit generate-types --wait
```

#### CI resilience: committed types as fallback

In blocking mode (`--wait`), the generator attempts to fetch real types from your warehouse, but delegates to **committed type files** (`shared/appkit-types/analytics.d.ts` and, when Metric Views are configured, `shared/appkit-types/metric-views.ts`) as the fallback when the warehouse is unreachable. These generated files should be part of your repository. On a fresh CI checkout, every build attempts to DESCRIBE against the warehouse; the committed types are used only when that cannot complete.

The generator **never overwrites committed types with degraded (`result: unknown`) types** — it writes real types, or it does not write at all.

A **two-bucket failure taxonomy** determines whether the build crashes or falls back to committed types:

- **Deterministic failures (always crash):** SQL syntax errors in your queries (genuine DESCRIBE failure against a reachable warehouse), HTTP 404 (bad or unknown warehouse ID), HTTP 400 (malformed request). These are developer or configuration errors that committed types must not hide.
- **Environmental failures (gate on committed types):** Authentication failures (401/403), network unreachability, warehouse unavailability (cold, deleting, or deleted), wait timeout on `RUNNING`, or any unrecognized failure. If every type file required by the app exists, the build **keeps them, emits a loud warning to stderr, and succeeds (exit 0)**. If a required file is missing, the build **crashes** with a message instructing you to run `npx @databricks/appkit generate-types --wait` locally (against a reachable warehouse) and commit the generated type files.

The loud warning is a single greppable stderr line naming the coarse cause (auth blocked / warehouse unreachable / warehouse unavailable) and the warehouse ID, so CI logs surface that the build fell back to committed types.

For a Metric Views app, `metric-views.ts` must already exist before an environmental failure can fall back successfully. Unlike a declaration-only artifact, this file also exports the runtime `metricViewsMetadata` value consumed by the server, so `analytics.d.ts` alone cannot satisfy the gate.

The app template wires this up for you: `postinstall` and `predev` run the non-blocking default, while `prebuild` runs `--wait`.

## Metric-view types

`generate-types` (and the Vite plugin) emit metric-view types **additively** — there is no separate command. When a `config/metric-views/definitions.json` file is present, the same run that generates your query types also DESCRIBEs each declared [UC Metric View](../plugins/analytics.md) and writes `metric-views.ts` into `shared/appkit-types/`:

- `metric-views.ts` — augments the `MetricRegistry` interface so `useMetricView('<key>', …)` is autocompleted and type-checked. Each view's measures, dimensions, and their semantic metadata (SQL type, display name, format, time grains) are encoded at the type level. The same file also exports a runtime `metricViewsMetadata` constant (the same metadata as a value, not just types) — inject it via `analytics({ metricViewsMetadata })` so the metric route can carry per-column display metadata in its response payload. The type augmentation erases at build; the constant is a normal named export and is tree-shaken away when unused. See [the analytics plugin's metric-view docs](../plugins/analytics.md) for the hook + format-utility wiring.

If `config/metric-views/definitions.json` is absent the metric path stays dormant (nothing is emitted). When present it follows the **same** warehouse-readiness contract as query types: in the default non-blocking run a view that can't be described yet — a cold warehouse, or a bad/unreachable source — is written with permissive types and a warning, while under `--wait` metric views obey the [two-bucket taxonomy](#ci-resilience-committed-types-as-fallback) (environmental failures gate to committed `metric-views.ts` + warn; deterministic failures like malformed definitions crash the build). A malformed `definitions.json` (invalid JSON, or a source that isn't a three-part UC FQN) fails fast in every mode.

`definitions.json` is keyed by metric key; each entry names the three-part UC FQN of the view and, optionally, the executor it runs as (`app_service_principal`, the default, or `user`):

```json
{
  "$schema": "https://databricks.github.io/appkit/schemas/metric-source.schema.json",
  "metricViews": {
    "revenue": { "source": "catalog.schema.revenue_metrics" },
    "customers": {
      "source": "catalog.schema.customer_metrics",
      "executor": "user"
    }
  }
}
```

The optional `$schema` line enables editor autocomplete and validation against the published schema.

## How it works

The type generator:

1. Scans your `config/queries/` folder for `.sql` files
2. Parses SQL parameter annotations (e.g., `-- @param startDate DATE`)
3. Connects to your Databricks SQL Warehouse to infer result column types
4. Generates TypeScript interfaces for query parameters and results
5. Creates a `QueryRegistry` type for type-safe query execution

### Parameters during `DESCRIBE QUERY`

Type generation describes each query without binding real parameters, so it
substitutes a placeholder default for every `:param` (e.g. `''` for a string).
That breaks queries whose shape depends on a value — most notably dynamic table
names via `IDENTIFIER(:catalog || '.schema.table')`. Annotate such parameters
with a sample value (`-- @param catalog STRING = main`) so the describe call can
resolve a real table. The sample value is used only at type-generation time; the
runtime query still binds the actual parameter. See
[SQL parameters → Sample values](../plugins/analytics.md#sample-values-for-type-generation).

## Using generated types

Once types are generated, your IDE will provide autocomplete and type checking:

```tsx
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { sql } from "@databricks/appkit-ui/js";

// TypeScript knows "users_list" is a valid query key
// and what parameters it expects
const { data } = useAnalyticsQuery("users_list", {
  status: sql.string("active"),
  limit: sql.number(50),
});

// TypeScript knows the shape of the result rows
data?.forEach((row) => {
  console.log(row.email); // ✓ autocomplete works
});
```

## See also

- [Plugins](../plugins/analytics.md) - Analytics plugin configuration
- [API Reference](/docs/api/appkit-ui) - Complete UI components API documentation
