---
sidebar_position: 4
---

# Database plugin (beta)

The **database plugin** is the application-level layer over Lakebase. It owns
schema declaration, type generation, drift detection, auto-mounted CRUD
routes, and a typed `db` browser client — all driven by a single
`config/database/schema.ts`.

> **Beta:** the manifest declares `stability: "beta"`. The CLI and runtime
> APIs are stable enough for non-critical workloads but may change before GA.

**Key features:**

- Single source of truth: `config/database/schema.ts` declares tables once.
- Auto-mounted REST surface at `/api/database/<entity>` per table.
- Typed `db.<entity>` browser client (no hand-written types).
- Live schema drift detection at boot — fail-closed in production.
- On-Behalf-Of (OBO) execution: `appkit.database.<entity>.asUser(req)`.
- Optional Row-Level Security helpers via `appkit db rls`.

## Basic usage

```ts
// server
import { createApp, server } from "@databricks/appkit";
import { database } from "@databricks/appkit/beta";

const app = await createApp({ plugins: [server(), database()] });
const cases = await app.database.cases.where({ status: "New" }).limit(50).toArray();
```

```ts
// browser (types come from the generated DatabaseRegistry)
import { db } from "@databricks/appkit-ui/js";
const cases = await db.cases.where({ status: "New" }).limit(50).toArray();
```

## Convention

The plugin auto-loads `config/database/schema.ts` (one of these paths is
probed: `config/database/schema.ts`, `config/database/schema/index.ts`, or
the `dist/` build artifacts).

```ts
// config/database/schema.ts
import { defineSchema, id, text, timestamp } from "@databricks/appkit";

export default defineSchema(({ table }) => ({
  user: table("user", {
    id: id(),
    email: text().notNull(),
    createdAt: timestamp().defaultNow().notNull(),
  }),
}));
```

## Auto-mounted routes

Each table gets six conventional routes plus a metadata pair:

| Method | Path                            | Purpose                            |
|--------|----------------------------------|------------------------------------|
| GET    | `/api/database/<e>`              | List rows (filters, order, paging) |
| GET    | `/api/database/<e>/count`        | Count rows matching filters        |
| GET    | `/api/database/<e>/:id`          | Find one row by primary key        |
| POST   | `/api/database/<e>`              | Create a row (upsert via `Prefer`) |
| PATCH  | `/api/database/<e>/:id`          | Update by primary key              |
| DELETE | `/api/database/<e>/:id`          | Delete by primary key              |
| GET    | `/api/database/<e>/_columns`     | Public column metadata for forms   |
| GET    | `/api/database/_entities`        | Discovery — list of entities       |
| GET    | `/api/database/_healthz`         | Readiness probe (`SELECT 1`)       |

By default every verb runs OBO (on-behalf-of the forwarded user). Override
per-entity via the `http` config:

```ts
database({
  http: {
    user: {
      list: "service",   // service-principal
      delete: false,     // disable the DELETE route entirely
      columns: "service" // override the metadata gate
    },
  },
});
```

## CLI lifecycle

```bash
npx appkit db init                 # one-command Lakebase onboarding
npx appkit db generate <name>      # scaffold a table (greenfield)
npx appkit db introspect           # pull existing schema (brownfield)
npx appkit db migration generate   # author a new SQL migration
npx appkit db migrate up           # apply migrations (advisory-locked)
npx appkit db verify               # detect drift between schema.ts and DB
npx appkit db rls <table> <args>   # scaffold a Row-Level Security policy
```

`db migrate up` takes a Postgres advisory lock so two concurrent deploys
cannot race the same migration. The flag `--dry-run` prints the plan
without applying.

`db init` prints an env-diff before touching `.env`, backs up the existing
file to `.env.bak`, and refuses to drop a branch under `--from reset`
without an interactive confirmation.

## Hooks

Add per-entity lifecycle hooks via `database({ hooks: { ... } })`:

```ts
database({
  hooks: {
    user: {
      beforeCreate: async (data, ctx) => ({ ...data, createdBy: ctx.userId }),
      afterCreate: async (row) => audit(row.id, "created"),
    },
  },
});
```

`upsert` is a separate channel from `create` and `update` — `beforeUpsert`
does **not** fan out into `beforeCreate` / `beforeUpdate`. Use a shared
helper if you need the same logic in both branches.

## OBO and forwarded headers

Per-user execution reads `x-forwarded-email` and `x-forwarded-access-token`
from the request. The Databricks Apps gateway strips inbound copies and
injects authentic values, so the plugin trusts these headers in production.
In dev the same headers are accepted from anywhere so the local loop stays
unblocked.

## Pool sizing

The service-principal (SP) pool defaults to 10 connections. Per-user (OBO)
pools default to 4 connections each, and the registry caps at 25 distinct
users. Worst-case fan-out is therefore `(1 + 25) × 4 + 10 = 114` connections
per app instance — tune via `connection.max` and `oboPoolMax` for your
Lakebase tier.

## Drift detection

Boot fails closed in production when `schema.ts` and the live DB disagree on
column types or declared-but-missing tables. Additive drift (live-only
columns/tables) is logged as a warning so blue/green deploys aren't blocked.

Customize with `database({ checkDrift: false })` to skip the check, or
`tolerateSetupFailure: true` to log-and-continue on schema-load errors.
