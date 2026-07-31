---
sidebar_position: 5
---

# Type generation

AppKit can automatically generate TypeScript types for your SQL queries, providing end-to-end type safety from database to UI.

## Goal

Generate type-safe TypeScript declarations for query keys, parameters, and result rows.

All generated files live in `shared/appkit-types/`, one per concern: `analytics.d.ts` (SQL query types), `serving.d.ts` (model-serving endpoint types), and `metric-views.d.ts`. A single command (and the Vite plugin) produces them all in one pass; see [Metric-view types](#metric-view-types). The `.d.ts` files use [`declare module`](https://www.typescriptlang.org/docs/handbook/declaration-merging.html#module-augmentation) to augment existing interfaces, so the types apply globally — you never need to import them. TypeScript auto-discovers them through `"include": ["shared/appkit-types"]` in your tsconfig.

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

In blocking mode the generator skips the warehouse entirely for any query whose types are already in the [type cache](#type-cache) (a cache **hit** makes zero warehouse round-trips). Only a cache **miss** contacts the warehouse: it starts a stopped warehouse, waits (bounded) for it to reach `RUNNING`, and then describes the query. A miss that cannot be resolved to a real type — a deleted warehouse, or (see below) a CI environment with no warehouse access — **fails the build** rather than shipping `result: unknown`. A transient connectivity blip still degrades gracefully. The app template wires this up for you: `postinstall` and `predev` run the non-blocking default, while `prebuild` runs `--wait`.

## Type cache

Type generation is backed by a per-app cache so that unchanged queries never pay for a repeat `DESCRIBE`. The cache lives in a committed `.appkit/` directory at your app root:

- `.appkit/types-cache.json` — query and metric-view DESCRIBE results
- `.appkit/serving-types-cache.json` — model-serving endpoint schemas

**`.appkit/` is a committed build artifact — check it into git; do not add it to `.gitignore`.** Committing it is what lets a blocking (`--wait`) build succeed with **no warehouse access**: on a fresh `git checkout` + `pnpm install`, every query is already a cache hit, so the build makes zero warehouse round-trips. (Ephemeral coordination state — a background-worker lock and the UI-variant choices file — stays under `node_modules/.databricks/appkit/` and is *not* committed.)

The cache serializes deterministically (top-level keys sorted), so a no-op regeneration produces a no-op diff and unrelated query changes don't collide in merges.

### Deploying without warehouse access

If your CI/CD environment cannot reach a SQL warehouse (for example, an authorization boundary removes warehouse access from the deploy pipeline), a blocking build still works **as long as the committed `.appkit/` cache covers every query** — all hits, no warehouse needed.

This imposes a rollout ordering: **produce and commit `.appkit/` while the warehouse is still reachable, then remove warehouse access.** A build that runs after warehouse access is gone with an uninitialized or incomplete cache fails loudly (never silently degrades to `unknown`), and the error message tells you which case you hit:

- **Uninitialized cache** (no `.appkit/` yet) — run `generate-types --wait` against a warehouse and commit `.appkit/`.
- **Drifted cache** (a query changed since the cache was built) — regenerate the affected query against a warehouse and commit the updated `.appkit/`.

## Metric-view types

`generate-types` (and the Vite plugin) emit metric-view types **additively** — there is no separate command. When a `config/metric-views/definitions.json` file is present, the same run that generates your query types also DESCRIBEs each declared [UC Metric View](../plugins/analytics.md) and writes `metric-views.d.ts` into `shared/appkit-types/`:

- `metric-views.d.ts` — augments the `MetricRegistry` interface so `useMetricView('<key>', …)` is autocompleted and type-checked. Each view's measures, dimensions, and their semantic metadata (SQL type, display name, format, time grains) are encoded at the type level.

If `config/metric-views/definitions.json` is absent the metric path stays dormant (nothing is emitted). When present it follows the **same** warehouse-readiness contract as query types: in the default non-blocking run a view that can't be described yet — a cold warehouse, or a bad/unreachable source — is written with permissive types and a warning, while under `--wait` that same situation fails the build so CI never ships incomplete metric types. A malformed `definitions.json` (invalid JSON, or a source that isn't a three-part UC FQN) fails fast in every mode.

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
