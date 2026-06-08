---
sidebar_position: 5
---

# Type generation

AppKit can automatically generate TypeScript types for your SQL queries, providing end-to-end type safety from database to UI.

## Goal

Generate type-safe TypeScript declarations for query keys, parameters, and result rows.

All generated files live in `shared/appkit-types/`, one per plugin (e.g. `analytics.d.ts`). They use [`declare module`](https://www.typescriptlang.org/docs/handbook/declaration-merging.html#module-augmentation) to augment existing interfaces, so the types apply globally — you never need to import them. TypeScript auto-discovers them through `"include": ["shared/appkit-types"]` in your tsconfig.

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

In blocking mode the generator starts a stopped warehouse, waits (bounded) for it to reach `RUNNING`, and then describes your queries. It fails only when the configured warehouse no longer exists (deleted/deleting), so a transient outage or a cold warehouse degrades gracefully rather than breaking the build. The app template wires this up for you: `postinstall` and `predev` run the non-blocking default, while `prebuild` runs `--wait`.

## How it works

The type generator:

1. Scans your `config/queries/` folder for `.sql` files
2. Parses SQL parameter annotations (e.g., `-- @param startDate DATE`)
3. Connects to your Databricks SQL Warehouse to infer result column types
4. Generates TypeScript interfaces for query parameters and results
5. Creates a `QueryRegistry` type for type-safe query execution

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
data?.forEach(row => {
  console.log(row.email); // ✓ autocomplete works
});
```

## See also

- [Plugins](../plugins/analytics.md) - Analytics plugin configuration
- [API Reference](/docs/api/appkit-ui) - Complete UI components API documentation
