---
sidebar_position: 4
---

# Database plugin (beta)

<!-- AUTO-GENERATED: stability-banner-start -->
:::warning Beta plugin
This plugin is currently **beta**. APIs may change between minor releases. Import from `@databricks/appkit/beta`. See [Plugin Stability Tiers](./stability.md).
:::
<!-- AUTO-GENERATED: stability-banner-end -->

The **database plugin** is the application-level layer over Lakebase. It owns
schema declaration, type generation, drift detection, auto-mounted CRUD
routes, and a typed `db` browser client — all driven by a single
`config/database/schema.ts`.

> **Beta:** the manifest declares `stability: "beta"`. The CLI and runtime
> APIs are stable enough for non-critical workloads but may change before GA.
> See [Known limitations](#known-limitations-beta) for what is not yet covered.

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
import { defineSchema, fk, id, text, timestamp } from "@databricks/appkit";

export default defineSchema(({ table }) => {
  const user = table("user", {
    id: id(),
    email: text().notNull(),
    createdAt: timestamp().defaultNow().notNull(),
  });

  const post = table("post", {
    id: id(),
    authorId: fk(user.id).notNull(),
    title: text().notNull(),
  });

  return { user, post };
});
```

`fk(target)` mirrors `target`'s pgType (integer, text, uuid, …) and registers
both forward and reverse relations on the schema graph. Those relations
power `.include()` on the typed client.

## Including related entities

Foreign keys declared with `fk(target)` are exposed on both endpoints of the
relation — the side that holds the column gets a singular include, the side
being pointed to gets an array.

```ts
const author = await db.post.include({ user: true }).first();
author?.user;

const enriched = await db.user
  .include({ post: { select: ["id", "title"] } })
  .toArray();
enriched[0]?.post;
```

Includes serialize to `?include=` (PostgREST-style) and execute as a single
SQL query on the server. Use `select` per-relation to project specific
columns and avoid over-fetching nested rows.

### Custom joins

`.include()` covers schema-declared relations. For ad-hoc joins without an
FK (cross-schema, polymorphic, conditional), use a custom plugin endpoint
with `app.database.sql` — a tagged template that parameterizes values and
returns rows directly:

```ts
app.route.get("/api/posts/with-counts", async (_req, res) => {
  const rows = await app.database.sql`
    SELECT u.id, u.email, COUNT(p.id) AS post_count
    FROM "user" u
    LEFT JOIN "post" p ON p.author_id = u.id
    GROUP BY u.id, u.email
  `;
  res.json(rows);
});
```

Use `.asUser(req).sql` to scope the query to the forwarded user's OBO pool.

## Auto-mounted routes

Each table gets six conventional routes plus discovery and health metadata:

| Method | Path                            | Purpose                            |
|--------|----------------------------------|------------------------------------|
| GET    | `/api/database/<e>`              | List rows (filters, order, paging) |
| GET    | `/api/database/<e>/count`        | Count rows matching filters        |
| GET    | `/api/database/<e>/:id`          | Find one row by primary key        |
| POST   | `/api/database/<e>`              | Create a row (upsert via `Prefer`) |
| PATCH  | `/api/database/<e>/:id`          | Update by primary key              |
| DELETE | `/api/database/<e>/:id`          | Delete by primary key              |
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
    },
  },
});
```

## CLI lifecycle

```bash
npx appkit db init                      # one-command Lakebase onboarding
npx appkit db introspect                # pull existing schema (brownfield)
npx appkit db migration generate <name> # author a new SQL migration
npx appkit db migrate up                # apply migrations (advisory-locked)
npx appkit db migrate status            # list applied vs pending migrations
npx appkit db verify                    # detect drift between schema.ts and DB
npx appkit db rls <entity> <spec>       # scaffold a Row-Level Security policy
npx appkit db seed                      # apply config/database/seed.sql
npx appkit db setup:dev                 # provision a per-user dev branch
npx appkit db types generate            # regenerate typed client artifacts
```

`db migrate up` takes a Postgres advisory lock so two concurrent deploys
cannot race the same migration. The flag `--dry-run` prints the plan
without applying.

`db init` prints an env-diff before touching `.env`, backs up the existing
file to `.env.bak`, and refuses to drop a branch under `--from reset`
without an interactive confirmation.

## Hooks

`ctx.userId` is the forwarded email — a label, not authz; `undefined` under
SP. Guard before writing it as audit metadata:

```ts
database({
  hooks: {
    user: {
      beforeCreate: async (data, ctx) => ({
        ...data,
        ...(ctx.userId ? { createdBy: ctx.userId } : {}),
      }),
      afterCreate: async (row) => audit(row.id, "created"),
    },
  },
});
```

`upsert` is its own channel — `beforeUpsert` / `afterUpsert` fire on
`create({ upsert: true })`; `beforeCreate` / `beforeUpdate` do **not**.

## Row-Level Security

`appkit db rls <entity> <spec>` writes a numbered migration, registers it
in `meta/_journal.json`, and emits `ENABLE` + `FORCE ROW LEVEL SECURITY`
(Postgres bypasses RLS for table owners by default — `FORCE` covers the SP
pool). The first run also emits a helpers migration with `current_user_email()`,
which reads the `app.user_id` GUC AppKit `SET`s on every OBO connection
(rename via [`rls.sessionVariable`](#configuration)).

```bash
npx appkit db rls case "owner_email:owner_email"        # SELECT/UPDATE/DELETE
npx appkit db rls case "owner_email:owner_email" --action insert
npx appkit db rls case "tenant_id = current_setting('app.tenant_id')::uuid"
```

`owner_email:<col>` expands to `<col> = current_user_email()`. Anything else
is raw SQL (rejected on semicolons, comments, unbalanced parens). Use
`--dry-run` to preview without writing.

`--action select,update` emits one policy per verb with derived names
(`<base>_select`, `<base>_update`); `all` is exclusive.

## OBO and forwarded headers

OBO reads `x-forwarded-email` and `x-forwarded-access-token`. The Databricks
Apps gateway strips inbound copies and injects authentic values; the plugin
trusts them in production. Dev accepts them from anywhere — **don't expose
the dev server beyond loopback** unless you front it with the same trust
boundary.

## Pool sizing

SP pool: 10. OBO pools: 2 connections each, registry capped at 100 users
(LRU). Worst-case fan-out per instance: `(1 + 100) × 2 + 10 = 212`. Tune via
`connection.max` and `oboPoolMax`. Lakebase's PgBouncer multiplexes client
connections, so effective headroom is larger than the raw tier limit.

## Drift detection

Boot fails closed in production when `schema.ts` and the live DB disagree on
column types or declared-but-missing tables. Additive drift (live-only
columns/tables) is logged. Policies are not compared.

`database({ checkDrift: false })` skips the check;
`tolerateSetupFailure: true` logs schema-load errors instead of throwing.

## Configuration

| Key                              | Default        | Notes                                                      |
|----------------------------------|----------------|------------------------------------------------------------|
| `connection.max`                 | 10             | SP pool max connections                                     |
| `oboPoolMax`                     | 100            | Distinct OBO pools kept alive (LRU evicts beyond this)      |
| `statementTimeoutMs`             | 15_000         | Server-side `statement_timeout` per pooled connection       |
| `checkDrift`                     | `true`         | Run drift introspection at boot                             |
| `tolerateSetupFailure`           | `false`        | Log instead of throw on schema-load / drift errors          |
| `healthCheck`                    | enabled        | Set `false` to suppress `/api/database/_healthz`            |
| `entitiesDiscovery`              | enabled        | Set `false` to suppress `/api/database/_entities`           |
| `rls.sessionVariable`            | `"app.user_id"` | GUC name AppKit `SET`s on OBO connect (RLS reads it)        |

## `column.private()` — partial

Filters the typegen registry, but row payloads from
`select`/`find`/`update().returning()` still include the value. **Treat as a
"hide from forms" hint, not authz** — keep true secrets in a separate table
with stricter ACLs.

## Known limitations (beta)

- **`column.private()` is a UX hint, not authz** — see above.
- **No policy drift detection** — `db verify` doesn't compare `pg_policies`.
- **Browser 404 semantics** — `db.<entity>.find(missingId)` and
  `update(missingId, ...)` return `null` (not throw).
- **`in` lists capped** — URL builder bounds `in` to stay under proxy
  limits; partition large lists client-side.
- **Dev mode trusts forwarded headers from any source** — see *OBO and
  forwarded headers*.
