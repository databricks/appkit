import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool, PoolClient } from "pg";

import { createLogger } from "../../logging/logger";
import { ownershipHint, quoteIdentifier } from "./ownership";
import {
  BASELINE_TAG,
  type Journal,
  type JournalEntry,
  MIGRATIONS_TABLE,
  MigrationFilesError,
  readJournal,
  readJsonFile,
} from "./paths";

const logger = createLogger("database");

interface ApplyMigrationsOptions {
  /** Absolute path of the committed migrations folder. */
  readonly migrationsFolder: string;
  /** Journal schema = app schema. */
  readonly schemaName: string;
}

interface ApplyMigrationsResult {
  /** Tags applied by this call, in order. */
  readonly applied: readonly string[];
  /** Tags recorded without running, because the catalog already held them (the baseline). */
  readonly adopted: readonly string[];
}

/** lock_not_available: a table lock was not granted within LOCK_TIMEOUT. */
const LOCK_NOT_AVAILABLE = "55P03";
/**
 * Longest wait for a table lock while migrating. Past it the migration fails;
 * waiting longer would queue every other query on that table behind it.
 */
const LOCK_TIMEOUT = "30s";

function failureHint(code: string | undefined): string | undefined {
  if (code === LOCK_NOT_AVAILABLE) {
    return `Another session held a lock on a table this migration changes for over ${LOCK_TIMEOUT}; deploy again once it finishes.`;
  }
  return ownershipHint(code);
}

/**
 * A statement failed while migrating. Pending migrations run in one drizzle-orm
 * migrator transaction, so none of them were applied; a baseline adopted just
 * before commits on its own and stays recorded.
 */
export class MigrationApplyError extends Error {
  /** Tags that were being applied; empty when reading the recorded migrations failed. */
  readonly pending: readonly string[];
  /** SQLSTATE of the failing statement, when the driver reported one. */
  readonly code?: string;
  /** Tags this run recorded as applied before the failure. */
  readonly adopted: readonly string[];

  constructor(
    pending: readonly string[],
    code: string | undefined,
    options: { cause?: unknown; adopted?: readonly string[] } = {},
  ) {
    const adopted = options.adopted ?? [];
    const sqlState = code ? ` (SQLSTATE ${code})` : "";
    const failure =
      pending.length > 0
        ? `Applying migration${pending.length === 1 ? "" : "s"} ${pending.join(", ")} failed${sqlState}; none were applied.`
        : `Reading the recorded migrations in ${MIGRATIONS_TABLE} failed${sqlState}; none were applied.`;
    const kept =
      adopted.length > 0
        ? ` ${adopted.join(", ")} stays recorded as applied: its tables already existed.`
        : "";
    const hint = failureHint(code);
    super(`${failure}${kept}${hint ? ` ${hint}` : ""}`, {
      cause: options.cause,
    });
    this.name = "MigrationApplyError";
    this.pending = Object.freeze([...pending]);
    this.code = code;
    this.adopted = Object.freeze([...adopted]);
  }
}

/**
 * Nothing is recorded yet and the database holds only part of what
 * 0000_baseline declares: neither running nor adopting the baseline would be safe.
 */
export class MigrationBaselineMismatchError extends Error {
  readonly problems: readonly string[];

  constructor(schemaName: string, problems: readonly string[]) {
    super(
      `Cannot adopt ${BASELINE_TAG}: schema "${schemaName}" has no recorded migrations and only part of the baseline: ${problems.join("; ")}. ` +
        "Create the missing tables and columns (or drop the partial ones), or regenerate the baseline with `appkit db introspect` against this database.",
    );
    this.name = "MigrationBaselineMismatchError";
    this.problems = Object.freeze([...problems]);
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** drizzle wraps driver errors; the SQLSTATE lives somewhere on the cause chain. */
function sqlStateOf(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    // No SQLSTATE class starts with "E"; Node system errors (EPIPE, EPERM, …) all do.
    if (typeof code === "string" && SQLSTATE.test(code) && code[0] !== "E") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** One lock per app schema, so concurrent instances apply in turn. */
export function migrationLockKey(schemaName: string): string {
  return createHash("sha256")
    .update(`appkit:migrations:${schemaName}`)
    .digest()
    .readBigInt64BE(0)
    .toString();
}

type QueryClient = Pick<PoolClient, "query">;

/**
 * `created_at` of the last migration the database recorded; null when none is.
 * An empty journal table counts as nothing recorded: drizzle-orm creates it
 * before its transaction, so a failed first deploy leaves one behind.
 */
async function lastRecordedMigration(
  client: QueryClient,
  schemaName: string,
): Promise<number | null> {
  // pg_catalog needs no privileges, so a missing grant is not mistaken for a missing table.
  const table = await client.query(
    `select 1 from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2`,
    [schemaName, MIGRATIONS_TABLE],
  );
  if (table.rows.length === 0) return null;
  const last = await client.query<{ last: string | number | null }>(
    `select max(created_at) as last from ${quoteIdentifier(schemaName)}.${quoteIdentifier(MIGRATIONS_TABLE)}`,
  );
  const value = last.rows[0]?.last;
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Journal entries newer than the last recorded migration: drizzle-orm's own
 * rule, so this agrees with what its migrator runs.
 *
 * Known gap, shared with drizzle-orm: an entry older than the last recorded one
 * (e.g. merged from a parallel branch) is never applied, and an applied
 * migration edited later goes unnoticed. strandedMigrations reports both.
 */
function pendingEntries(
  journal: Journal,
  lastRecorded: number | null,
): JournalEntry[] {
  if (lastRecorded === null) return journal.entries;
  return journal.entries.filter((entry) => entry.when > lastRecorded);
}

/** Fail before connecting, naming the file, rather than inside drizzle-orm's migrator. */
function assertMigrationFiles(folder: string, journal: Journal): void {
  for (const entry of journal.entries) {
    const file = path.join(folder, `${entry.tag}.sql`);
    if (!fs.existsSync(file)) {
      throw new MigrationFilesError(
        `Missing ${file}, listed in meta/_journal.json. Restore it from version control.`,
      );
    }
  }
}

/**
 * Run `work` on one dedicated connection under the per-schema advisory lock,
 * with no statement timeout and at most LOCK_TIMEOUT per table lock. The
 * connection is always unlocked, reset and released; a connection whose
 * cleanup fails is destroyed, not reused.
 */
async function withMigrationLock<T>(
  pool: Pick<Pool, "connect">,
  schemaName: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const lockKey = migrationLockKey(schemaName);
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SET statement_timeout = 0");
    const attempt = await client.query<{ locked: boolean }>(
      "select pg_catalog.pg_try_advisory_lock($1::bigint) as locked",
      [lockKey],
    );
    if (!attempt.rows[0]?.locked) {
      logger.info(
        "Waiting for another instance to finish migrating schema %s",
        schemaName,
      );
      await client.query("select pg_catalog.pg_advisory_lock($1::bigint)", [
        lockKey,
      ]);
    }
    locked = true;
    // Only now: lock_timeout would also cut short the wait for the advisory lock.
    await client.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
    return await work(client);
  } finally {
    const cleanup: Array<() => Promise<unknown>> = [];
    if (locked) {
      cleanup.push(() =>
        client.query("select pg_catalog.pg_advisory_unlock($1::bigint)", [
          lockKey,
        ]),
      );
    }
    cleanup.push(() => client.query("RESET lock_timeout"));
    cleanup.push(() => client.query("RESET statement_timeout"));

    let cleanupError: Error | undefined;
    for (const step of cleanup) {
      try {
        await step();
      } catch (error) {
        cleanupError ??=
          error instanceof Error ? error : new Error(String(error));
      }
    }
    // A connection that may still hold the lock or the session settings must not be reused.
    client.release(cleanupError);
  }
}

async function inTransaction(
  client: QueryClient,
  work: () => Promise<void>,
): Promise<void> {
  await client.query("begin");
  try {
    await work();
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

/** The tables and columns a migration snapshot (meta/NNNN_snapshot.json) declares in one schema. */
function snapshotTables(
  folder: string,
  idx: number,
  schemaName: string,
): Map<string, string[]> {
  const file = path.join(
    folder,
    "meta",
    `${String(idx).padStart(4, "0")}_snapshot.json`,
  );
  if (!fs.existsSync(file)) {
    throw new MigrationFilesError(
      `Missing ${file} for ${BASELINE_TAG}. Restore it from version control; it lists the tables the baseline adopts.`,
    );
  }
  const snapshot = readJsonFile<{
    tables?: Record<
      string,
      { name: string; schema?: string; columns: Record<string, unknown> }
    >;
  }>(file);
  const tables = new Map<string, string[]>();
  for (const table of Object.values(snapshot.tables ?? {})) {
    if ((table.schema || "public") !== schemaName) continue;
    tables.set(table.name, Object.keys(table.columns));
  }
  return tables;
}

type BaselineState =
  | { readonly kind: "absent" }
  | { readonly kind: "present" }
  | { readonly kind: "partial"; readonly problems: readonly string[] };

/** Compare the baseline's tables and columns with pg_catalog. */
async function baselineState(
  client: QueryClient,
  options: ApplyMigrationsOptions,
  baseline: JournalEntry,
): Promise<BaselineState> {
  const declared = snapshotTables(
    options.migrationsFolder,
    baseline.idx,
    options.schemaName,
  );
  if (declared.size === 0) return { kind: "absent" };
  const { rows } = await client.query<{
    table_name: string;
    column_name: string | null;
  }>(
    `select c.relname::text as table_name, a.attname::text as column_name
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       left join pg_catalog.pg_attribute a
         on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = $1 and c.relkind in ('r', 'p')
        and c.relname = any($2::text[])`,
    [options.schemaName, [...declared.keys()]],
  );
  const found = new Map<string, Set<string>>();
  for (const row of rows) {
    const columns = found.get(row.table_name) ?? new Set<string>();
    if (row.column_name) columns.add(row.column_name);
    found.set(row.table_name, columns);
  }
  if (found.size === 0) return { kind: "absent" };

  const problems: string[] = [];
  for (const [table, columns] of declared) {
    const qualified = `${options.schemaName}.${table}`;
    const present = found.get(table);
    if (!present) {
      problems.push(`table ${qualified} does not exist`);
      continue;
    }
    const missing = columns.filter((column) => !present.has(column));
    if (missing.length > 0) {
      problems.push(
        `table ${qualified} is missing ${missing.length === 1 ? "column" : "columns"} ${missing.join(", ")}`,
      );
    }
  }
  return problems.length > 0
    ? { kind: "partial", problems }
    : { kind: "present" };
}

/**
 * Record migrations as applied without running them: create the journal table
 * as drizzle-orm's migrator does, then insert one row per tag with the
 * migrator's own hash (sha256 of the .sql file) and `created_at` (the journal's
 * `when`). Runs on the caller's connection; wrap it in a transaction.
 */
async function recordMigrationsApplied(
  client: QueryClient,
  options: ApplyMigrationsOptions,
  journal: Journal,
  tags: readonly string[],
): Promise<void> {
  // One file per journal entry, in journal order.
  const files = readMigrationFiles({
    migrationsFolder: options.migrationsFolder,
  });
  const schema = quoteIdentifier(options.schemaName);
  const table = `${schema}.${quoteIdentifier(MIGRATIONS_TABLE)}`;
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  // drizzle-orm's own definition, so its migrator later reads and extends this table.
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${table} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`,
  );
  for (const tag of tags) {
    const index = journal.entries.findIndex((entry) => entry.tag === tag);
    const file = files[index];
    if (index < 0 || !file) {
      throw new Error(`Migration ${tag} is not in the journal.`);
    }
    await client.query(
      `insert into ${table} ("hash", "created_at") values($1, $2)`,
      [file.hash, file.folderMillis],
    );
  }
}

/** Tags of the committed migrations the database has not recorded, oldest first. */
export async function pendingMigrationTags(
  client: QueryClient,
  options: ApplyMigrationsOptions,
): Promise<string[]> {
  const journal = readJournal(options.migrationsFolder);
  if (!journal) return [];
  const last = await lastRecordedMigration(client, options.schemaName);
  return pendingEntries(journal, last).map((entry) => entry.tag);
}

/** A committed migration drizzle-orm's migrator will never run on this database. */
export interface StrandedMigration {
  readonly tag: string;
  /**
   * "out of order": older than the last recorded migration but not recorded
   * (merged from a parallel branch). "edited": recorded, but the file changed
   * since.
   */
  readonly reason: "out of order" | "edited";
}

/**
 * Committed migrations the migrator skips for good: it runs only entries newer
 * than the last recorded one, and never compares hashes. Recorded rows carry
 * the journal's `when` and the file's sha256, so each entry is matched by its
 * `when`. Read-only.
 */
export async function strandedMigrations(
  client: QueryClient,
  options: ApplyMigrationsOptions,
): Promise<StrandedMigration[]> {
  const journal = readJournal(options.migrationsFolder);
  if (!journal) return [];
  const last = await lastRecordedMigration(client, options.schemaName);
  if (last === null) return [];
  assertMigrationFiles(options.migrationsFolder, journal);
  // One file per journal entry, in journal order.
  const files = readMigrationFiles({
    migrationsFolder: options.migrationsFolder,
  });
  const recorded = await client.query<{
    hash: string;
    created_at: string | number;
  }>(
    `select hash, created_at from ${quoteIdentifier(options.schemaName)}.${quoteIdentifier(MIGRATIONS_TABLE)}`,
  );
  const hashAt = new Map(
    recorded.rows.map((row) => [Number(row.created_at), row.hash]),
  );
  const stranded: StrandedMigration[] = [];
  journal.entries.forEach((entry, index) => {
    // Newer entries are pending: the migrator runs them.
    if (entry.when > last) return;
    const hash = hashAt.get(entry.when);
    if (hash === undefined) {
      stranded.push({ tag: entry.tag, reason: "out of order" });
    } else if (hash !== files[index]?.hash) {
      stranded.push({ tag: entry.tag, reason: "edited" });
    }
  });
  return stranded;
}

/** recordMigrationsApplied in one transaction under the migration lock (introspect on an AppKit branch). */
export async function markMigrationsApplied(
  pool: Pick<Pool, "connect">,
  options: ApplyMigrationsOptions,
  tags: readonly string[],
): Promise<void> {
  const journal = readJournal(options.migrationsFolder);
  if (!journal) {
    throw new MigrationFilesError(
      `Cannot record ${tags.join(", ")} as applied: ${options.migrationsFolder} has no meta/_journal.json.`,
    );
  }
  await withMigrationLock(pool, options.schemaName, (client) =>
    inTransaction(client, () =>
      recordMigrationsApplied(client, options, journal, tags),
    ),
  );
}

/**
 * Apply every committed migration the database has not recorded yet.
 *
 * Runs on one dedicated connection as the connecting identity, which owns what
 * it creates (see ownership.ts), under a per-schema advisory lock; drizzle-orm's
 * migrator runs only when something is pending.
 *
 * Baseline adoption: when nothing is recorded yet and `0000_baseline` comes
 * first, the baseline's tables are looked up in pg_catalog. None present → it
 * runs like any migration. All present → it is recorded as applied, in its own
 * transaction, and only later migrations run. Anything in between →
 * MigrationBaselineMismatchError, nothing changes.
 */
export async function applyPendingMigrations(
  pool: Pick<Pool, "connect">,
  options: ApplyMigrationsOptions,
): Promise<ApplyMigrationsResult> {
  const journal = readJournal(options.migrationsFolder);
  if (!journal || journal.entries.length === 0) {
    return { applied: [], adopted: [] };
  }
  assertMigrationFiles(options.migrationsFolder, journal);

  return withMigrationLock(pool, options.schemaName, async (client) => {
    const adopted: string[] = [];
    // What the failing step was applying, for the error.
    let applying: readonly string[] = [];
    try {
      const lastRecorded = await lastRecordedMigration(
        client,
        options.schemaName,
      );
      let pending = pendingEntries(journal, lastRecorded);
      if (pending.length === 0) return { applied: [], adopted };

      const first = journal.entries[0];
      if (lastRecorded === null && first?.tag === BASELINE_TAG) {
        applying = [BASELINE_TAG];
        const state = await baselineState(client, options, first);
        if (state.kind === "partial") {
          throw new MigrationBaselineMismatchError(
            options.schemaName,
            state.problems,
          );
        }
        if (state.kind === "present") {
          await inTransaction(client, () =>
            recordMigrationsApplied(client, options, journal, [BASELINE_TAG]),
          );
          adopted.push(BASELINE_TAG);
          pending = pending.filter((entry) => entry.tag !== BASELINE_TAG);
          if (pending.length === 0) return { applied: [], adopted };
        }
      }

      applying = pending.map((entry) => entry.tag);
      await migrate(drizzle({ client }), {
        migrationsFolder: options.migrationsFolder,
        migrationsSchema: options.schemaName,
        migrationsTable: MIGRATIONS_TABLE,
      });
      return { applied: applying, adopted };
    } catch (error) {
      if (
        error instanceof MigrationBaselineMismatchError ||
        error instanceof MigrationFilesError
      ) {
        throw error;
      }
      throw new MigrationApplyError(applying, sqlStateOf(error), {
        cause: error,
        adopted,
      });
    }
  });
}
