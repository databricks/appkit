# 001 - Database development flow

| | |
|---|---|
| **Status** | Draft |
| **Owner** | Victor Ditadi |

The [Google Doc](https://docs.google.com/document/d/1bsMsYsTfoFBSYS3YbXn3FvOOUQl21X829Z4u1I-fBzg/edit) is the copy for comments and edits. Changes there are synced to this file.

## Background and Motivation

The DatabasePlugin (`@databricks/appkit/beta`, shipped in v0.87 and v0.88) turns `config/database/schema.ts` into
typed server access and generated CRUD routes over Lakebase Postgres. It reads tables. It never creates them. Today a
developer gets from an idea to a deployed table by hand:

| Step | Today on `main` |
|---|---|
| Pick a database | `databricks apps init` asks for a Lakebase project, branch and database. The plugin is `hidden: true`, so only apps that add it by hand get this far. |
| Develop locally | `.env` points at the branch the app deploys to. Every developer reads and writes production rows. |
| Create a table | Run DDL by hand, then declare the table in `schema.ts`. The plugin's startup check fails until both match. |
| Permissions | The app's service principal has no `CREATE` on `public`. Someone grants it, or creates the tables as another role and grants access. |
| Change a table | Run `ALTER` by hand on every branch that needs it, in the right order, and remember which branches already have it. |
| Review | Schema changes are not in the pull request. Reviewers see `schema.ts` only. |
| Deploy | Nothing ties a code deploy to the schema it needs. A missing column surfaces as the app failing its startup check. |

Lakebase sets the constraints any design has to live with:

- A branch fork copies its parent's data, its roles, and its objects with their owners. Role state is per branch.
- `GRANT ... TO databricks_superuser` is rejected. A custom `NOLOGIN` role can own app objects, and its members get
  owner rights, but someone with `ADMIN OPTION` on it has to grant it to each new identity.
- On `public`, only `pg_database_owner` and `databricks_superuser` have `CREATE`. A role with `CREATE` on the
  database can create and own a schema of its own.
- A role is created and deleted through the Lakebase role API. Deleting a role can reassign what it owns
  (`reassign_owned_to`).
- A project holds 500 branches, archived ones included, and an internal quota of 25 unarchived branches
  ([LKB-15175](https://databricks.atlassian.net/browse/LKB-15175)). 20 computes run at once outside the default
  branch.
- The pooled endpoint is not available to OAuth roles and runs PgBouncer in transaction mode, which has no advisory
  locks. Apps connect to the direct endpoint.

Apps sets two more:

- A horizontally scaled app rolls a deploy to one instance first while the others keep serving, up to five instances.
- Removing a database resource from an app hands the service principal's objects to the app manager. Re-adding it
  restores database access but not object ownership, so the next deploy fails with `permission denied for schema`
  ([XTA-18463](https://databricks.atlassian.net/browse/XTA-18463)).
- Genie App Builder builds on AppKit. Its apps scale to zero after 30 idle minutes, so start runs on every cold start,
  and they deploy from the UI with no CI step.

The stack below this design was built and verified against a Lakebase project with a throwaway deploy branch and app.
Its PR descriptions record the live results.

## Goals

1. From `databricks apps init` to a deployed app with one table, a developer runs no SQL, grants nothing and opens no
   console.
2. Each developer works on a Lakebase branch of their own. Only the deployed app changes the branch it deploys to.
3. Schema changes are committed as SQL migrations and reviewed with the code that needs them.
4. A deploy applies exactly the migrations its commit carries, or fails before serving with a message that names the
   migration and the fix.
5. Every command that writes refuses a branch it was not built for, before it connects.

## Out of Scope

- Down migrations and automatic schema rollback. Fixes go forward.
- Per-user database identities (OBO). The plugin runs as the app's service principal.
- Several apps sharing one Postgres schema.
- drizzle-kit v1's migration folder format. This design ships on drizzle-kit 0.31 (journal v7).
- Seeding or copying data into the deploy branch.
- Migrations that cannot run in a transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`).

## Product Decisions

### The schema lives in TypeScript, and migrations are committed SQL

`config/database/schema.ts` stays the source of truth. `appkit db migrate` writes drizzle-kit output under
`config/database/migrations/`: one `NNNN_<name>.sql` per change, a `meta/NNNN_snapshot.json` per migration and
`meta/_journal.json`. The SQL is what reviewers read and what the deployed app runs.

### Every developer gets a Lakebase branch

`appkit db init` forks the project's default branch into one of two kinds:

- `dev-<user>-<hash6>`, one per developer, no expiry, the same name on every machine.
- `session-<hash6>-<id>`, one per checkout, with a 7-day TTL. The id lives in `.env` as `APPKIT_DB_SESSION`.

`<hash6>` is the first six hex characters of the SHA-256 of the user name, so a branch name says whose it is.

The developer gets a Postgres role with `DATABRICKS_SUPERUSER` on that branch, and owns the app's objects there.
`.env` then points at the branch. A fork copies production rows. See Security Considerations.

Branches count against the project's limits, so init keeps them cheap. It creates the branch's endpoint with a
5-minute scale to zero, because an idle compute counts against the 20 active ones. When the project is at its branch
limit, init stops before creating anything and lists your other branches with the command that deletes them. With the
quota of 25, a project holds the deploy branch and about 20 developers with one branch each, fewer when they also keep
session branches. The 20 active computes cap how many of them work at the same time.

CI needs no branch, because `appkit db check` runs offline. A CI job that wants a live branch runs
`appkit db init --session --ttl 1h` and deletes it at the end with `appkit db clean --delete-branch`.

### The deployed app applies its migrations when it starts

The app applies the committed migrations its deploy branch has not recorded, as its service principal, before it
serves. Developers never migrate the deploy branch. This is the only option that keeps one owner per branch with no
extra resource to deploy. See the architecture decision below.

### Tables default to the Postgres schema `app`

`defineSchema()` without `schemaName` puts tables in `app`. The service principal creates and owns `app` on its first
start, so the first deploy needs no grant. `{ schemaName: "public" }` keeps working for apps that already use it, but
migrations on start cannot create objects there without a manual `GRANT CREATE ON SCHEMA public`.

### Existing beta apps keep working after the upgrade

An app that upgrades from v0.88 does not start migrating, because the deploy flag below is off unless `apps init` set
it. If the startup check finds every missing table in `public`, its error says the default moved to `app` and offers
`{ schemaName: "public" }`. The release notes carry an upgrade section.

### Seven commands, each with one job

| Command | Job | Needs a database |
|---|---|---|
| `appkit db init` | Point `.env` at your dev or session branch, creating it when missing. | Yes |
| `appkit db migrate` | Write a migration when `schema.ts` changed, then apply pending migrations to your branch. | Yes |
| `appkit db introspect` | Write `schema.ts` and a baseline from tables that already exist on your branch. | Yes |
| `appkit db clean` | Drop the app schema on your branch, or with `--delete-branch` the branch. | Yes |
| `appkit db seed` | Run `config/database/seed.sql` on your branch. | Yes |
| `appkit db verify` | Read-only check of your branch, or with `--deployed -t <target>` of a target's deployed app. | Yes, or API only |
| `appkit db check` | Offline check of the committed history, for CI. | No |

`appkit db init` asks nothing. It keeps this checkout's session branch when `.env` points at one and otherwise uses
your dev branch. `--session` and `--dev` switch between them. `appkit db check` is the only check that runs in CI
without Lakebase credentials.

## Architecture Decisions

### Migrate on start, behind an explicit flag

The plugin applies migrations in `setup()`, after the pool opens and before the schema check and `server.start()`.
It runs only when `APPKIT_DB_MIGRATE_ON_START=true` and the process has service principal credentials
(`DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET`). `apps init` writes the flag into `app.yaml` for apps that
select the plugin. `.env` never carries it, so `npm start` on a laptop never migrates.

`databricks apps run-local` reads `app.yaml`, so it sets the flag, but it sets no service principal credentials. It
migrates only when the shell exports them. As a second guard, migrate on start refuses when `LAKEBASE_ENDPOINT` names
a `dev-` or `session-` branch, because only a developer migrates those.
Rejected alternatives:

| Option | Why not |
|---|---|
| Infer deployment from the environment | False positive on a local `npm start` with M2M credentials. No way to turn it off. |
| An admin migrates the deploy branch from the CLI | A human step on every schema change, by a person with DDL rights on the production branch. App Builder has nobody to run it. |
| A shared owner role, with CI migrating on merge ([tmm Lakebase Agentic CI](https://github.com/databricks/tmm/tree/main/Lakebase-Agentic-CI)) | Works. It needs a one-time bootstrap on the deploy branch by someone with `ADMIN OPTION`, database credentials in CI, and a grant to every new app service principal. Developers skip the fork hand-off only if they are members on the deploy branch, which gives them DDL rights there. App Builder apps have no CI. |
| A one-shot migration job per deploy | Adds a resource to every app, and still needs a shared owner role and its bootstrap so the app can use what the job created. |
| A bundle script hook | Runs as the person or CI identity that deploys, which then owns the objects. |

The decision costs two rules that the docs and `appkit db migrate` carry:

- **Each migration works with the previous release.** A horizontally scaled rollout updates one instance first while
  the old instances keep serving. A dropped, renamed or retyped column breaks them. Drops go in a later deploy than
  the code that stops using the column (expand, then contract). `appkit db migrate` warns when it writes a drop, a
  rename, a type change or `SET NOT NULL`.
- **A migration fits in the start window.** A migration that runs longer than the platform's start timeout can never
  land. Long backfills run as a separate job against the deploy branch, not as a migration.

### One transaction per migration

Each pending migration commits in its own transaction, in journal order, with the journal row drizzle-orm would
write. A deploy then replays the same commits the developer's branch went through one `appkit db migrate` at a time.

drizzle-orm's migrator runs every pending migration in one transaction. That fails on deploy for changes that applied
cleanly on the dev branch. `ALTER TYPE ... ADD VALUE` in one migration and a use of the new value in the next fails
with SQLSTATE 55P04 when both run together. A failure after some migrations commit leaves the app not started and
the old instances serving. Because every migration works with the previous release, that state is safe, and the next
deploy resumes from it.

The alternative keeps one transaction and refuses, before `begin`, a batch where an enum value is added before the
last migration. It keeps all-or-nothing, but the deploy still differs from what the developer ran.

### One lock per schema, with a bounded wait

A session advisory lock keyed on the schema name serializes instances that start together. The wait polls
`pg_try_advisory_lock` until a 5-minute deadline, and each poll logs the holder from `pg_locks` and
`pg_stat_activity`. The migrating session sets `application_name = 'appkit-migrate'` so an operator can find it, and
`client_connection_check_interval` so Postgres cancels a statement whose instance was killed. Without it a killed
instance's statement keeps running and holds the lock. `lock_timeout` is 5s, with up to three tries per
migration. A waiting `ACCESS EXCLUSIVE` request queues every later query on its table, so the timeout bounds how long
traffic stalls, not only the migration.

Most starts have nothing to apply, and an App Builder app starts on every cold start. The migrator reads the recorded
rows first without the lock. It takes the lock only when an entry is pending, then reads again under it. A current
branch then costs one connection and one read of the journal table on the start path.

A transaction-mode pooler would void a session lock. The pooled Lakebase endpoint is closed to OAuth roles, so the
plugin connects direct. The connector refuses a `-pooler` host so that stays true.

### Fail closed on a history the migrator would skip

drizzle-orm applies only journal entries newer than the last recorded `created_at`. Two developers who add migrations
on parallel git branches produce, after the merge, an entry older than one the deploy branch already ran. That entry
is skipped for good. The startup schema check catches a skipped `CREATE TABLE` but not a skipped index, constraint,
backfill or `DROP`.

The migrator reconciles the committed history with the recorded rows once, under the lock, as a pure function:

| State | Meaning | On start |
|---|---|---|
| `empty` | No journal table, or no rows. | Apply all, or adopt the baseline. |
| `pending` | Entries newer than the last recorded one. | Apply them. |
| `current` | Every entry recorded with its hash. | Nothing. |
| `stranded` | An entry older than the last recorded one, not recorded. | Fail. Nothing changes. |
| `edited` | A recorded entry whose file hash changed. | Warn. |
| `ahead` | A recorded row with no committed entry, for example after a code rollback. | Warn. |
| `partial-baseline` | `0000_baseline` tables exist only in part. | Fail. Nothing changes. |

`appkit db check` fails in CI when `when` does not increase with `idx` or an `idx` is not its position, when the
snapshot `prevId` chain forks, when a listed file is missing or a `.sql` is not listed, or when `schema.ts` differs
from the latest snapshot. A journal on `main` that only grows can then never strand an entry on the deploy branch,
because the deploy branch applies a prefix of it. Two pull requests that both add `0001_migration` conflict in git
first, and the check catches a resolution that keeps both. To fix a failed check, the developer merges `main`, resets
`config/database/migrations` to `main`'s, and runs `appkit db clean` and `appkit db migrate`. Migrate writes their
change again after `main`'s migrations. The clean is there because their branch already ran the old migration.

Two other fixes lose. Applying by hash instead of by `when` runs DDL in an order nobody reviewed. A custom journal
forks drizzle-kit's format, and drizzle-kit v1 already replaces the journal.

### One owner per branch

The identity that runs a branch's migrations owns the app's objects there. On the deploy branch that is the app's
service principal. On a dev or session branch it is the developer. There is no shared owner role and no `SET ROLE`,
because Lakebase rejects `GRANT ... TO databricks_superuser`.

A fork copies objects with their owners, so `appkit db init` hands the fork's app objects to the developer. It deletes
the fork's copy of the role that owns schema `app` and reassigns its objects (`reassign_owned_to`). It touches only
that role, on the fork, and says so before it does.

The role delete returns HTTP 500 when Postgres refuses the drop with SQLSTATE 2BP01, for example when the role still
owns objects in another database of the branch
([ES-2265656](https://databricks.atlassian.net/browse/ES-2265656), open). Init lists that role's remaining
dependencies from `pg_shdepend` before the delete, and on a 500 prints them with the fix instead of the API error.

Single ownership by the service principal breaks when that principal changes. A recreated app has a new one, and
removing and re-adding the database resource hands the objects to the app manager (XTA-18463). Either way the app
can no longer use or alter its schema, and its next start fails. The startup error names the current owner of schema
`app` and the manual recovery, which the docs repeat. When the owner belonged to a deleted app, someone with CAN MANAGE
on the project runs `databricks postgres delete-role <old role> --reassign-owned-to <new role>`, which moves the
objects and deletes the old role. Otherwise the owner transfers the schema. A tool for it is an open question.

### Branch policy is one resolver and one table

One function resolves the `.env` branch to a kind, in this order: project default, protected, deploy target, dev
(yours), session (this checkout), other. Every command reads that kind. The rules live in one table:

| Kind | `init` | `migrate` | `introspect` | `clean`, `seed` | `verify` |
|---|---|---|---|---|---|
| dev (yours), session (this checkout) | Use | Write and apply | Write and record | Run | Read |
| deploy target, project default, protected, other | Refuse | Write only | Refuse | Refuse | Read |

`init` resolves the kind of the branch it would create or reuse before creating it or writing `.env`. A deploy target
is the branch any `databricks.yml` target binds, on the app's `postgres` resource or in `postgres_branch`. One reader
serves the guard, `init` and `verify`. It follows `include:` and resolves variables per target. `verify` also warns
when `.env` points at a branch that is not yours.

The name allowlist is the safety boundary. Only `dev-<you>-<your hash>` and `session-<your hash>-<this checkout>` are
writable, and the denylist checks come first. Before connecting, the CLI checks that `PGHOST` is a host of
`LAKEBASE_ENDPOINT`.

### drizzle-kit generates, the plugin applies

drizzle-kit 0.31.10 generates migrations through `drizzle-kit/api`. It is an exact optional peer dependency, loaded
lazily from the `@databricks/appkit/database-tooling` entry point that the runtime never imports. The loader checks
the installed version and the `drizzle-orm` it resolves, and prints the install command on a mismatch.

`appkit db init` installs drizzle-kit as a dev dependency when it is missing, since only database apps run it. A
template dev dependency would add about 32 MB, 12 downloads and two deprecation warnings to every app, including apps
that never use it. The template ships one lockfile, so it cannot be dropped per app.

The shared CLI's view of the tooling API is an interface exported from `shared`, and an appkit test assigns the
tooling's exports to it. Drift then fails typecheck.

### Introspect renders the AppKit builder, not drizzle's DSL

`appkit db introspect` reads `pg_catalog` and renders `defineSchema()` code. `drizzle-kit pull` emits drizzle's
`pgTable` DSL, which the plugin does not accept, and most of the renderer is skip and approximation policy that pull
does not have. Every catalog string reaches the output escaped. Nineteen hostile names, including newline, CR,
U+2028, U+2029, `*/`, backtick and `${`, loaded without running code.

Introspect records its migration as applied only if the branch's last recorded migration is the one just before it,
checked inside the migration lock. A branch ahead of the checkout would otherwise record DDL it never ran.

### Flag Strategy

| Flag | Default | Introduced in | Turning it off |
|---|---|---|---|
| `APPKIT_DB_MIGRATE_ON_START` (app env) | Off. `apps init` renders `true` into `app.yaml` for database apps. | #654 | The app never migrates. The startup schema check still runs. |
| `hidden` in the plugin manifest | `true` | Already on `main` | `apps init` does not offer the plugin. Removed in #675. |
| `appkit db` hidden from `--help` | Hidden | #666 | Discoverability only. The commands are local tools and change only branches `init` created. Shown in #675. |

Not flagged:

- The `app` default (#655). The plugin is beta, which allows API changes in a minor release, and the startup hint
  plus the upgrade note cover existing apps.
- `appkit db check`, `verify` and `introspect` on your own branch. They are read-only or write only local files and
  your own branch.

## Main Design

### A new app, from scaffold to deploy

1. `databricks apps init` scaffolds the app with the plugin. It asks for the Lakebase project and the deploy branch
   and database, which go into `databricks.yml`.
2. `apps init` runs `appkit db init`, which asks nothing. It forks the project's default branch into
   `dev-<user>-<hash6>`, adds a read-write endpoint and the developer's role, hands the fork's app objects to the
   developer, writes `.env`, and starts the schema (migrate when `schema.ts` exists, introspect otherwise).
3. The developer declares a table in `schema.ts` and runs `appkit db migrate`. It writes `0000_migration.sql`,
   regenerates `shared/appkit-types/database.d.ts`, and applies the migration to the dev branch.
4. The developer commits `config/database/` and runs `databricks apps deploy`.
5. The app starts with `APPKIT_DB_MIGRATE_ON_START=true`. Under the lock it reconciles, applies `0000`, creates and
   owns schema `app`, checks the declared tables, and listens.

Until the CLI release that runs `appkit db init` ships, the developer runs it once after scaffolding, as the README
says. Until then `.env` points at the branch picked in the prompts, usually the deploy branch, and `appkit db verify`
warns about it.

### A table change

Edit `schema.ts`, run `appkit db migrate`, commit, deploy. CI runs `appkit db check`. After the deploy,
`appkit db verify --deployed -t <target>` reports whether the app is running with every committed migration.

### A second developer

Clone, install, `appkit db init`. Init forks the default branch, which already holds the deployed migrations, and
applies any committed migration the fork has not recorded.

### Existing tables

On a fork that has tables but no `schema.ts`, `appkit db init` runs introspect. It writes `schema.ts` and
`0000_baseline`, records the baseline on the fork, and the deployed app adopts it on start when every baseline table
and column already exists. A partial match fails start and changes nothing.

### API Changes

- CLI: `appkit db init | migrate | introspect | clean | seed | verify | check`.
- `defineSchema()` defaults `schemaName` to `"app"`.
- Package export `@databricks/appkit/database-tooling`. It is internal, with no semver guarantee outside the CLI.
- App env: `APPKIT_DB_MIGRATE_ON_START`. Local env written by init: `LAKEBASE_PROJECT`, `LAKEBASE_ENDPOINT`,
  `PGHOST`, `PGDATABASE`, `APPKIT_DB_SESSION`, and `DATABRICKS_CONFIG_PROFILE` or `DATABRICKS_HOST`.
- Flags: `appkit db init --dev | --session`, `--ttl <duration>` for session branches,
  `--schema <migrate|introspect|clean|none>` and `-y, --yes`. `appkit db clean --delete-branch`.
  `appkit db verify --deployed` and `-t, --target <name>`.
- Optional peer dependency: `drizzle-kit` `0.31.10`.

## Observability

Migrations run before `TelemetryManager.start()` registers the tracer provider, so a span opened during setup is
dropped. The migrator returns `lockWaitMs`, per-migration `durationMs`, the state, and the tags. The plugin logs them
as one structured event per run. After setup completes it emits a `database.migrate` span with explicit start and end
times and these attributes: `applied_count`, `adopted_count`, `state`, `outcome`, `sqlstate`. It also records a
duration histogram and an outcome counter. Tags and SQL text are never attributes. The start log names the branch,
the schema and the role.

## Security Considerations

- **Dev branches copy production data.** A fork of the default branch copies its rows, and the developer gets
  `DATABRICKS_SUPERUSER` on it. That role is required, because it is the only role API membership that grants
  `CREATE` on the database. The docs say so. `appkit db init --schema clean` starts the fork with an empty `app`
  schema, but rows in other schemas stay.
- **Creating branches needs CAN MANAGE on the project.** That also allows deleting the deploy branch. The narrowest
  permission is an open question.
- **Writes stay on your branches.** The name allowlist, the denylist and the `PGHOST` check run before any connection.
- **Generated code.** Introspect escapes every catalog string that reaches `schema.ts`. Tests cover each escape
  vector, including CR and U+2029.
- **No driver text leaves the server.** Startup errors carry the SQLSTATE and the migration tag. Clients see
  `Database setup failed`.
- **`.env`.** Init writes it with mode 0600 through a temporary file and a rename, and refuses a symlink. When `.env`
  is missing, init writes its own keys and the profile or host it authenticated with. It never copies `.env.example`,
  whose `DATABRICKS_HOST` is a placeholder.
- **Session branches are bound to a user.** With the user hash in the name, a copied `.env` fails the guard for
  everyone but its creator.

## Platform Dependencies

| Ask | Why |
|---|---|
| Databricks CLI: `apps init` runs `appkit db init` after install. | Removes the manual init step. Without it the README tells the developer to run init. |
| Databricks CLI: a minimum version recorded in the template. | An older CLI scaffolds without init, and `.env` points at the deploy branch until the developer runs it. `appkit db verify` warns meanwhile. |
| Lakebase: `client_connection_check_interval` allowed for app roles. | Cancels the statement of a killed instance that still holds the migration lock. |
| Lakebase: role delete returns the 2BP01 dependency error as a 4xx, not a 500 ([ES-2265656](https://databricks.atlassian.net/browse/ES-2265656), open). | Init's hand-off fails on every rerun when it hits this, with no reason given. |
| Lakebase: raise the quota of 25 unarchived branches per project ([LKB-12894](https://databricks.atlassian.net/browse/LKB-12894), backlog, proposes 100). | One branch per developer caps a project at about 20 developers. |
| Apps: keep object ownership with the app across a database resource remove and re-add ([XTA-18463](https://databricks.atlassian.net/browse/XTA-18463), to do). | The app cannot use its own schema after a re-add, and start fails. |
| Apps: the start timeout and whether a non-zero exit restarts the app. | Sets the lock wait and the longest migration. The template exits 1 on a failed start. |

## Rollout Plan

1. **Design.** Land this doc. Done when the Apps, Lakebase and CLI reviewers have answered the open questions marked
   for them.
2. **Runtime, dark.** Land #654 and #655 with the flag, the per-migration transactions, the reconcile states and the
   bounded lock. Done when a real-Postgres test suite passes in CI, and the dev-playground deployed with the flag on
   applies `0000` and then `0001`.
3. **Commands, hidden.** Land #666 to #674. Done when a developer on the dev-playground runs `init`, `migrate` and
   `verify` on their own branch, and the deployed app applies the migration.
4. **Reveal.** Land #675, then #678 (`appkit db check`). Until a CLI release runs `appkit db init`, the README says to
   run it once. Done when `apps init` with the plugin, one table and a deploy need no step outside the README, and
   when two people on the dev-playground add migrations on parallel git branches, `appkit db check` fails a merge
   that keeps both, and the documented fix passes.
5. **GA of the plugin** is a separate plan.

## PR Stack

1. `00-design`: this doc.
2. [#654](https://github.com/databricks/appkit/pull/654) Migrations on deploy start: the flag, one transaction per
   migration, the reconcile states with fail-closed `stranded`, the bounded lock wait, a 5s lock timeout, the
   lock-free read on a current branch, the `-pooler` and developer-branch refusals, the schema owner in the startup
   error, structured migration events, and a real-Postgres suite.
3. [#655](https://github.com/databricks/appkit/pull/655) The `app` default schema, with the `public` hint in the
   startup check and an upgrade note.
4. [#666](https://github.com/databricks/appkit/pull/666) `appkit db migrate`: the branch resolver, the drizzle-kit
   version check, the destructive-statement warning, and a checked tooling contract. A migration the run wrote is
   discarded when applying it fails.
5. [#670](https://github.com/databricks/appkit/pull/670) `appkit db introspect`: compare-and-set recording, only on
   your own branch, and catalog tests that run SQL.
6. [#672](https://github.com/databricks/appkit/pull/672) `appkit db init`, `clean`, `seed`: dev and session branches
   with no prompts, the hand-off of the app schema, the 2BP01 dependency report, the 5-minute scale to zero, the
   branch-limit stop, `--ttl` and `--delete-branch`, atomic `.env` writes, and the drizzle-kit install.
7. [#674](https://github.com/databricks/appkit/pull/674) `appkit db verify`: the local check, including `ahead` rows,
   and `--deployed` with `-t, --target`, which checks the host and compares the deployed journal with the local one.
   One `databricks.yml` reader serves the guard, `init` and `verify`.
8. [#675](https://github.com/databricks/appkit/pull/675) Offer the plugin in `apps init`: the flag in `app.yaml`, no
   drizzle-kit in the template, exit 1 on a failed start, a README that works before the CLI release, `verify`'s
   warning for a `.env` branch that is not yours, the recreated-app recovery in the owner error, and the docs.
9. [#678](https://github.com/databricks/appkit/pull/678) `appkit db check`.

## Open Questions

1. Should the app's service principal own the deploy branch's objects at all? XTA-18463 shows Apps moving them to the
   app manager on a resource re-add. A shared owner role survives that, but needs a holder of `ADMIN OPTION` that a
   zero-touch flow does not have. This is the decision most worth challenging. Reviewer: Lakebase, Apps, AppKit.
2. What is the Apps start timeout, and does a process that exits non-zero get restarted? SUP-36075 suggests about 10
   minutes, unconfirmed. Reviewer: Apps runtime.
3. Is `client_connection_check_interval` allowed for Lakebase roles? Reviewer: Lakebase.
4. What is the narrowest Lakebase permission that lets a developer fork a branch and manage roles on their own fork?
   CAN MANAGE also allows deleting the deploy branch. Reviewer: Lakebase.
5. Is a fork of production rows acceptable for customer data by default, or should init default to an empty schema?
   Does Lakebase offer schema-only branches? Reviewer: Lakebase, security.
6. How does an app with a new service principal take ownership back, after a recreate or a resource re-add? The
   stack documents a manual recovery with `databricks postgres delete-role --reassign-owned-to`. Options for a
   zero-touch one are Apps transferring ownership on re-add, or an `appkit db adopt --deployed` built on the role API.
   Reviewer: Lakebase, Apps.
7. What scale to zero do child branch computes get by default? Production gets 24 hours. Reviewer: Lakebase.
8. How does Genie App Builder drive this flow? Its apps have no per-developer `.env` and no CI, and they start on
   every cold start. Reviewer: App Builder.
9. Ship on drizzle-kit 0.31's journal, or wait for drizzle-kit v1's folder format, which removes the journal and its
   merge conflicts? Reviewer: AppKit.
10. Which CLI release runs `appkit db init`, and does it run before or after the dependency install? Init asks nothing,
    so it needs no flags. Reviewer: Databricks CLI.
11. This design has `appkit db init` install drizzle-kit. Should the CLI support per-plugin dependencies instead, so
    apps that select the plugin get it at scaffold time? Reviewer: AppKit, Databricks CLI.
