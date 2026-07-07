# CLAUDE.md

Guidance for Claude Code when working in this repository.

## About

Databricks AppKit is a modular TypeScript SDK for building Databricks apps with a plugin-based architecture. It's a **pnpm monorepo** (`pnpm@10`) orchestrated with **Turbo**, bundled with **tsdown**, and linted/formatted with **Biome** (not ESLint/Prettier).

## API Documentation

View the AppKit API reference (docs only — NOT for scaffolding/init):

```bash
npx @databricks/appkit docs            # ALWAYS run this index FIRST
npx @databricks/appkit docs <query>    # then view a section
npx @databricks/appkit docs --full     # full index, all entries
```

**Do not guess doc paths** — find them from the index. The full props/plugin API lives here, e.g. `npx @databricks/appkit docs ./docs/plugins.md`.

## Repository Structure

```
packages/
  appkit/      Core SDK (plugin architecture, CLI, connectors)
  appkit-ui/   React components + JS utilities
  lakebase/    Standalone Lakebase (PostgreSQL) connector
  shared/      Shared TypeScript types (bundled inline into packages)
apps/
  clean-app/        Minimal standalone template (Vite + React + Express)
  dev-playground/   Reference app — server/ (Node + AppKit), client/ (Vite + React 19)
docs/         Docusaurus site
template/     App template used by `databricks apps init`
tools/        Build/release/codegen scripts (see package.json scripts)
```

## Common Commands

The full command set is in root `package.json`. Most-used:

```bash
pnpm setup:repo       # one-time setup (corepack + pnpm enable first)
pnpm dev              # build all + Turbo watch (NODE_ENV=development)
pnpm build            # build packages, sync template, gen doc banners
pnpm test             # vitest run with coverage (test:watch for watch)
pnpm check:fix        # Biome lint + format, autofix
pnpm typecheck        # tsc across all packages (pnpm -r typecheck)
pnpm deploy:playground
```

Test environments: `appkit-ui` → jsdom (React), `appkit` → node.

### After Making Changes — always run
1. `pnpm build && pnpm docs:build`
2. `pnpm check:fix && pnpm -r typecheck`

### AppKit CLI (after `pnpm build`)
```bash
npx appkit plugin sync --write    # sync manifests → appkit.plugins.json
npx appkit plugin create          # scaffold a plugin (interactive)
npx appkit plugin validate        # validate manifest(s) against schema
npx appkit plugin list
npx appkit plugin add-resource    # add a resource requirement (interactive)
```

### Monorepo Dependencies
```bash
pnpm add -Dw <pkg>                          # root dev tool
pnpm --filter=@databricks/appkit add <pkg>  # package-specific
pnpm --filter=dev-playground add <pkg>      # app-specific
```
Workspace deps use `"@databricks/shared": "workspace:*"`. New packages extend root `tsconfig.json` and need `build:package` + `build:watch` scripts.

## Architecture

### Plugin execution interceptors
`execute()` / `executeStream()` apply interceptors outermost→innermost:
**Telemetry** → **Timeout** → **Retry** → **Cache**.
```typescript
await this.execute(() => expensiveOperation(), {
  cache: { ttl: 60000 }, retry: { maxRetries: 3 }, timeout: 5000, telemetry: { traces: true },
});
```

### Request flow
React client → HTTP POST / SSE → Express → routes `/api/{plugin-name}/{endpoint}` → `Plugin.injectRoutes()` → `this.execute()` → Databricks services. Dev: Vite HMR + `tsx watch`. Prod: static `client/dist` + compiled server bundle.

### SSE streaming
Built-in via `StreamManager`: connection-ID stream tracking, event ring buffer for replay on reconnect (`Last-Event-ID`), per-stream abort signals, heartbeats.

### Analytics query naming convention (non-obvious)
Queries live in `config/queries/`; file name sets execution context:
- `<key>.sql` — runs as **service principal** (shared cache)
- `<key>.obo.sql` — runs as **user** (on-behalf-of, per-user cache)

Parameterize all queries. Execute via `POST /api/analytics/query/:query_key`.

### Lakebase
Two layers: the standalone `@databricks/lakebase` package (`packages/lakebase/`, OAuth refresh + ORM helpers) and a thin AppKit wrapper (`packages/appkit/src/connectors/lakebase/`) adding logger integration. `createLakebasePool()` reads `PGHOST`/`PGDATABASE`/`LAKEBASE_ENDPOINT` and returns a standard `pg.Pool`. ORM examples (Drizzle/Sequelize/TypeORM) in `apps/dev-playground/server/lakebase-examples/`.

### Type generation
`tools/generate-registry-types.ts` builds plugin registry types so `AppKit.myPlugin.method()` is typed from registered plugins. Telemetry is OpenTelemetry (`TelemetryManager` singleton + per-plugin `TelemetryProvider`).

## Dev-Playground

Backend `apps/dev-playground/server/`: `index.ts` wires plugins; example plugins (`reconnect-`, `telemetry-example-`, `config-demo-`, `lakebase-examples-`) demonstrate features.
Frontend `apps/dev-playground/client/`: TanStack Router file-based routes in `src/routes/<page>.route.tsx`, root layout `__root.tsx`. **Add a page:** create the route file + nav link in `__root.tsx` (route tree regenerates on build).

## Environment

`apps/dev-playground/server/.env`:
```env
DATABRICKS_HOST=https://your-workspace.cloud.databricks.com
DATABRICKS_WAREHOUSE_ID=...                  # optional, for analytics
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318  # optional telemetry
```

## Commits

- **Sign off (DCO required):** `git commit -s -m "..."`
- **Conventional commits** (enforced by commitlint): `feat:` (minor), `fix:` (patch), `feat!:`/`BREAKING CHANGE:` (major), plus `chore:`/`docs:`/`refactor:`/`test:`.

## Releasing

Two-stage pipeline (details in `.github/workflows/` and `.release-it.json`): `prepare-release` builds + uploads artifacts on push to `main`; a secure repo verifies, publishes to npm via OIDC, then commits version/changelog/tag back. `appkit` + `appkit-ui` release together; `@databricks/lakebase` releases independently. Preview locally with `pnpm release:dry`.
