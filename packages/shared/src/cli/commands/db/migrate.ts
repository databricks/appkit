import { Command } from "commander";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  bullet,
  check,
  databasePaths,
  type LakebaseClient,
  type LakebasePool,
  loadIntrospector,
  loadSchemaFile,
  runCommandAction,
  warn,
  withLakebasePool,
} from "./shared";

const ADVISORY_LOCK_NAME = "appkit-db-migrate";

export const migrateCommand = new Command("migrate")
  .description("Run database migrations")
  .addCommand(
    new Command("up")
      .description("Apply pending migrations")
      .option(
        "--dry-run",
        "Print pending migrations without applying them or taking the advisory lock",
      )
      .action((opts: { dryRun?: boolean }) =>
        runCommandAction(() => migrateUp({ dryRun: Boolean(opts.dryRun) })),
      ),
  )
  .addCommand(
    new Command("status")
      .description("Show migration status")
      .action(() => runCommandAction(migrateStatus)),
  )
  .addCommand(
    new Command("reset")
      .description("Drop generated migrations metadata in development")
      .action(() => runCommandAction(migrateReset)),
  );

/**
 * Apply pending migrations under a Postgres session-level advisory lock so
 * two concurrent deploys cannot race the same migration. The lock is held on
 * the migration client for the lifetime of the migrator; a second runner
 * blocks on its own `pg_advisory_lock` call until the first releases.
 */
export async function migrateUp(
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  const paths = databasePaths();

  if (opts.dryRun) {
    console.log(
      bullet(
        `Dry run: would acquire advisory lock and apply migrations from ${paths.migrationsDir}`,
      ),
    );
    return;
  }

  await withLakebasePool(async (pool) => {
    const client = await getMigrationClient(pool);
    try {
      await acquireMigrationLock(client);
      try {
        await setMigrationSearchPath(client);
        console.log(bullet("Applying migrations with drizzle-orm migrator"));
        // drizzle-orm typings expect a `pg` PoolClient; the LakebaseClient shape
        // we expose is structurally compatible at runtime. Use `never` to opt out
        // of the strict positional typing.
        const db = drizzle(client as never);
        await migrate(db, { migrationsFolder: paths.migrationsDir });
      } finally {
        await releaseMigrationLock(client);
      }
    } finally {
      client.release?.();
    }
    console.log(check("Done."));
  });
}

async function acquireMigrationLock(client: LakebaseClient): Promise<void> {
  // pg_try_advisory_lock + bounded retry so a wedged CI session can't block
  // follow-on deploys forever.
  const LOCK_TIMEOUT_MS = 10 * 60 * 1000;
  const LOCK_RETRY_MS = 5_000;
  const lockDeadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    const { rows } = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('${ADVISORY_LOCK_NAME}')) AS acquired`,
    );
    if (rows[0]?.acquired) break;
    if (Date.now() >= lockDeadline) {
      throw new Error(
        `Migration advisory lock not acquired within ${LOCK_TIMEOUT_MS / 1000}s; another deploy may be wedged.`,
      );
    }
    console.log(bullet("Migration lock held by another runner; retrying…"));
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
  console.log(bullet("Acquired migration advisory lock."));
}

async function releaseMigrationLock(client: LakebaseClient): Promise<void> {
  try {
    await client.query(
      `SELECT pg_advisory_unlock(hashtext('${ADVISORY_LOCK_NAME}'))`,
    );
  } catch (error) {
    console.error(
      warn(
        `Failed to release migration advisory lock: ${(error as Error).message}`,
      ),
    );
  }
}

/**
 * Check out a dedicated client when the pool supports it; fall back to running
 * statements directly on the pool otherwise.
 *
 * Migrations need a single connection so `SET search_path` and the migrator's
 * `BEGIN/COMMIT` see the same session state.
 */
async function getMigrationClient(pool: LakebasePool): Promise<LakebaseClient> {
  if (pool.connect) return pool.connect();
  return {
    query: pool.query,
    release: undefined,
  };
}

/**
 * Pin the migration session to the schema declared by the user so that the
 * generated CREATE TABLE statements (which use unqualified names) land in the
 * right schema instead of falling back to `public`.
 */
async function setMigrationSearchPath(client: LakebaseClient): Promise<void> {
  const schemaName = await getDeclaredSchemaName();
  if (!schemaName) return;

  await client.query(
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`,
  );
  await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
}

async function getDeclaredSchemaName(): Promise<string | null> {
  const paths = databasePaths();
  const schema = await loadSchemaFile(paths.schemaFile);
  if (!schema) return null;

  const { schemaToIntrospection } = await loadIntrospector();
  const schemas = schemaToIntrospection(schema).schemas;
  return schemas.length === 1 ? schemas[0] : null;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

interface MigrationRow {
  hash: string;
  created_at: string | number;
}

export async function migrateStatus(): Promise<void> {
  await withLakebasePool(async (pool) => {
    try {
      const result = await pool.query<MigrationRow>(`
        SELECT hash, created_at
        FROM drizzle.__drizzle_migrations
        ORDER BY created_at DESC
      `);
      if (result.rows.length === 0) {
        console.log(check("No applied migrations."));
        return;
      }
      for (const row of result.rows) {
        console.log(`[applied] ${row.created_at} ${row.hash}`);
      }
    } catch (error) {
      // First-time invocation: the drizzle bookkeeping schema does not exist
      // yet. Treat it as "no migrations applied" rather than surfacing a
      // confusing internal-state error.
      if (
        error instanceof Error &&
        /drizzle\.__drizzle_migrations|does not exist/i.test(error.message)
      ) {
        console.log(check("No applied migrations."));
        return;
      }
      throw error;
    }
  });
}

export async function migrateReset(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("db migrate reset is forbidden in production.");
  }

  await withLakebasePool(async (pool) => {
    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    console.log(check("Dropped drizzle migration metadata schema."));
  });
}

/**
 * Drop every app table in the target schema and the Drizzle bookkeeping
 * schema. Used by `db init --from reset` to wipe a dev branch before
 * re-applying `schema.ts` from scratch.
 *
 * Dev-only: refuses in `NODE_ENV=production`. Dev branches are per-user
 * clones that can be recreated cheaply via `db init`, so no additional
 * confirm prompt is layered on top of the mode select.
 */
export async function dropAllAppTables(options: {
  schema: string;
}): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("db init --from reset is forbidden in production.");
  }

  await withLakebasePool(async (pool) => {
    const result = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1",
      [options.schema],
    );
    if (result.rows.length === 0) {
      console.log(check(`No tables to drop in schema "${options.schema}".`));
    } else {
      for (const row of result.rows) {
        await pool.query(
          `DROP TABLE IF EXISTS ${quoteIdentifier(options.schema)}.${quoteIdentifier(row.tablename)} CASCADE`,
        );
      }
      console.log(
        check(
          `Dropped ${result.rows.length} table(s) in schema "${options.schema}".`,
        ),
      );
    }
    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    console.log(check("Dropped drizzle migration metadata schema."));
  });
}
