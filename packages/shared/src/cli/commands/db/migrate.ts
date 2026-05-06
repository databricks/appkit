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
 * Apply pending migrations under a session-level advisory lock so two
 * concurrent deploys can't race. A second runner blocks on its own
 * `pg_advisory_lock` until the first releases.
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
        // LakebaseClient is structurally pg.PoolClient at runtime; cast `never`
        // to bypass drizzle-orm's strict positional typing.
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
  // try_advisory_lock + bounded retry so a wedged CI session can't block forever.
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
    // Surface as a real failure with the recovery hint — a stuck lock blocks
    // every subsequent deploy. New users won't know to look at pg_locks.
    console.error(
      warn(
        `Failed to release migration advisory lock: ${(error as Error).message}\n` +
          `  → Run \`SELECT pg_advisory_unlock_all()\` from a fresh psql session, ` +
          `or check pg_locks for the stuck owner.`,
      ),
    );
  }
}

/**
 * Dedicated client: `SET search_path`, the advisory lock, and BEGIN/COMMIT
 * MUST share one session — running through the pool would scatter them.
 */
async function getMigrationClient(pool: LakebasePool): Promise<LakebaseClient> {
  if (!pool.connect) {
    throw new Error(
      "Migration pool must support `connect()` so the advisory lock, search_path, and migrations share one session.",
    );
  }
  return pool.connect();
}

/**
 * Pin the session to the declared schema so unqualified CREATE TABLE statements
 * land there instead of falling back to `public`.
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
  if (schemas.length === 1) return schemas[0];
  if (schemas.length > 1) {
    console.warn(
      warn(
        `Schema declares ${schemas.length} schemas (${schemas.join(", ")}); skipping search_path. Tables will land in the migrator default — pin the schema explicitly to avoid surprises.`,
      ),
    );
  }
  return null;
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
      // First run: drizzle bookkeeping schema doesn't exist yet → "no migrations".
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
 * Drop every app table + the drizzle bookkeeping schema. Used by
 * `db init --from reset` to wipe a dev branch before re-applying schema.ts.
 * Dev-only — refuses in `NODE_ENV=production`.
 */
export async function dropAllAppTables(options: {
  schema: string;
  /** Defense-in-depth so a future caller can't bypass `confirmReset`. */
  allowDestructive?: boolean;
}): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("db init --from reset is forbidden in production.");
  }
  if (!options.allowDestructive) {
    throw new Error(
      "dropAllAppTables refused: caller must pass allowDestructive=true (db init --from reset wires this through confirmReset).",
    );
  }

  await withLakebasePool(async (pool) => {
    const result = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1",
      [options.schema],
    );
    if (result.rows.length === 0) {
      console.log(check(`No tables to drop in schema "${options.schema}".`));
      await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
      console.log(check("Dropped drizzle migration metadata schema."));
      return;
    }
    // Wrap all drops in a transaction — partial failure leaves the DB
    // half-dropped otherwise, which makes the dev branch unrecoverable
    // without manually finishing the wipe.
    if (!pool.connect) {
      throw new Error(
        "Reset requires `pool.connect` so drops can run in a single transaction.",
      );
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const row of result.rows) {
        await client.query(
          `DROP TABLE IF EXISTS ${quoteIdentifier(options.schema)}.${quoteIdentifier(row.tablename)} CASCADE`,
        );
      }
      await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release?.();
    }
    console.log(
      check(
        `Dropped ${result.rows.length} table(s) in schema "${options.schema}".`,
      ),
    );
    console.log(check("Dropped drizzle migration metadata schema."));
  });
}
