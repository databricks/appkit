# Database Plugin Playground Fixture

This fixture exercises the database plugin against a real Lakebase project.

## Quick start

For both new and existing databases:

```bash
pnpm exec tsx ../../packages/shared/src/cli/index.ts db init
```

`db init` will:

1. Ask which Databricks profile to use (or use `--profile`).
2. Ask which Lakebase project (or use `--project`).
3. Create or reuse your per-user dev branch (`dev-{slug}-{hash}`).
4. Write `.env` (`PGHOST`, `PGDATABASE`, `LAKEBASE_ENDPOINT`, etc.).
5. Detect whether the target schema is empty or populated.
6. Run the right path: `setup:dev` for a new database, `introspect + verify` for an existing one.

For scripted use (no prompts):

```bash
pnpm exec tsx ../../packages/shared/src/cli/index.ts db init \
  --profile DEFAULT \
  --project projects/ditadi-taskflow \
  --from introspect \
  --schema public \
  --yes
```

`--from` accepts:

- `migrate` — schema.ts is the source of truth. Generates a migration from
  `config/database/schema.ts` and applies it to the dev branch.
- `introspect` — the live branch is the source of truth. Writes
  `config/database/schema.ts` from the branch's existing tables.

Without `--from`, `db init` probes the target schema and suggests one (empty
schema → `migrate`, populated schema → `introspect`).

## Lower-level commands

These are what `db init` composes. Use them directly only when `init` is not
the right shape:

```bash
appkit db introspect --schema public          # write schema.ts from live DB
appkit db setup:dev --name init --seed        # generate + migrate + seed + verify
appkit db migration generate --name <change>  # diff schema.ts → migration SQL
appkit db migrate up                          # apply pending migrations (CI/prod)
appkit db verify                              # drift check (CI-friendly)
appkit db seed                                # run seed.sql against current DB
```

In CI and production, prefer `migration generate`, `migrate up`, and `verify`
over `init`/`setup:dev`. Those are the explicit primitives that don't refuse
production.
