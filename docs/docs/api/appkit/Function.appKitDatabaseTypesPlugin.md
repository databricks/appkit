# Function: appKitDatabaseTypesPlugin()

```ts
function appKitDatabaseTypesPlugin(options: AppKitDatabaseTypesPluginOptions): Plugin$1;
```

Vite plugin — regenerates `shared/appkit-types/database.d.ts` whenever
`config/database/schema.ts` changes during dev. In production (`vite build`)
it runs once at `buildStart`.

**Activation gate:** only when `config/database/schema.ts` exists, either at
the Vite root or its parent. Apps without a database plugin pay nothing.

**Dev path (decision #25):** while the dev server is running, the schema is
loaded via `server.ssrLoadModule` — Vite evaluates it in-process, same Node
runtime. No child spawn, no `tsx` cold start. Before a change triggers
regeneration, the module cache is invalidated so the next load sees fresh
source.

**Production path:** `buildStart` runs before `configureServer`, so the
loader falls through to the default dynamic `import()` — relying on the
parent process's tsx loader for TS support.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | `AppKitDatabaseTypesPluginOptions` |

## Returns

`Plugin$1`
