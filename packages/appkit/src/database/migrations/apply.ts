import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Pool, PoolClient } from "pg";

import { createLogger } from "../../logging/logger";
import {
  type MigrationFile,
  type RecordedMigration,
  reconcileMigrations,
} from "./history";
import {
  INSUFFICIENT_PRIVILEGE,
  ownershipHint,
  schemaOwnership,
} from "./ownership";
import {
  BASELINE_TAG,
  type Journal,
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
  /** Longest wait for another session's migration lock, in milliseconds. */
  readonly lockWaitMs?: number;
  /** Longest wait for each table lock a migration takes, in milliseconds. */
  readonly lockTimeoutMs?: number;
}

interface ApplyMigrationsResult {
  /** Tags applied by this call, in order. */
  readonly applied: readonly string[];
  /** Tags recorded without running, because the catalog already held them (the baseline). */
  readonly adopted: readonly string[];
  /** Recorded migrations whose committed file changed since; the change never runs. */
  readonly edited: readonly string[];
  /** Recorded migrations that are not committed here. */
  readonly unknown: number;
  /** Time spent waiting for another session's migration lock. */
  readonly lockWaitMs: number;
}

/** A deploy waits this long for another instance to finish migrating, then fails. */
const LOCK_WAIT_MS = 5 * 60_000;
/**
 * Longest wait for one table lock. Past it the migration rolls back and is
 * retried: a longer wait would queue every other query on that table behind it.
 */
const LOCK_TIMEOUT_MS = 5_000;
/** Tries per migration when a table lock is not granted within the lock timeout. */
const LOCK_ATTEMPTS = 3;
const LOCK_POLL_MS = 1_000;
const LOCK_REPORT_MS = 30_000;
/** Shown in pg_stat_activity, so a waiting instance can name the lock holder. */
const APPLICATION_NAME = "appkit-migrate";
/** Lets the server cancel a migration whose instance died. Linux servers only. */
const CONNECTION_CHECK_INTERVAL = "10s";

/** lock_not_available: a table lock was not granted within the lock timeout. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * A step of applying migrations failed. Each migration commits in its own
 * transaction: the failing one rolled back, the ones before it stay applied.
 */
export class MigrationApplyError extends Error {
  /** The migration that failed and rolled back; undefined when another step failed. */
  readonly failed?: string;
  /** Committed migrations still not applied, the failed one first. */
  readonly pending: readonly string[];
  /** Tags this run applied before the failure. */
  readonly applied: readonly string[];
  /** Tags this run recorded as applied (adopted) before the failure. */
  readonly adopted: readonly string[];
  /** SQLSTATE of the failing statement, when the driver reported one. */
  readonly code?: string;

  constructor(details: {
    /** What failed when no migration did, e.g. "Connecting to the database". */
    readonly step: string;
    readonly failed?: string;
    readonly pending?: readonly string[];
    readonly applied?: readonly string[];
    readonly adopted?: readonly string[];
    readonly hint?: string;
    readonly cause?: unknown;
  }) {
    const pending = details.pending ?? [];
    const applied = details.applied ?? [];
    const adopted = details.adopted ?? [];
    const code = sqlStateOf(details.cause);
    const systemCode = code ? undefined : systemCodeOf(details.cause);
    const reason = code
      ? ` (SQLSTATE ${code})`
      : systemCode
        ? ` (${systemCode})`
        : "";
    const parts = [
      details.failed
        ? `Migration ${details.failed} failed${reason} and was rolled back.`
        : `${details.step} failed${reason}.`,
    ];
    if (adopted.length > 0) {
      parts.push(
        `${adopted.join(", ")} stays recorded as applied: its tables already existed.`,
      );
    }
    if (applied.length > 0) {
      parts.push(`Applied before the failure: ${applied.join(", ")}.`);
    }
    parts.push(
      pending.length > 0
        ? `Not applied: ${pending.join(", ")}.`
        : "No migration was applied.",
    );
    if (details.hint) parts.push(details.hint);
    super(parts.join(" "), { cause: details.cause });
    this.name = "MigrationApplyError";
    this.failed = details.failed;
    this.pending = Object.freeze([...pending]);
    this.applied = Object.freeze([...applied]);
    this.adopted = Object.freeze([...adopted]);
    this.code = code;
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
        "Create the missing tables and columns (or drop the partial ones), or regenerate the baseline against this database.",
    );
    this.name = "MigrationBaselineMismatchError";
    this.problems = Object.freeze([...problems]);
  }
}

/**
 * Committed migrations are older than the last one the database recorded and
 * were never applied, so they would never run. Nothing was applied.
 */
export class MigrationHistoryError extends Error {
  readonly stranded: readonly string[];

  constructor(schemaName: string, stranded: readonly string[], last: string) {
    const many = stranded.length > 1;
    super(
      `Migration${many ? "s" : ""} ${stranded.join(", ")} ${many ? "are" : "is"} older than ${last}, which schema "${schemaName}" already recorded, ` +
        `and ${many ? "were" : "was"} never applied, so ${many ? "they" : "it"} would never run. This happens when migrations from parallel branches merge. ` +
        `Delete ${many ? "their" : "its"} .sql file, snapshot and journal entry, generate the migration again from schema.ts, and deploy again. ` +
        "No migration was applied.",
    );
    this.name = "MigrationHistoryError";
    this.stranded = Object.freeze([...stranded]);
  }
}

/** The migration lock stayed taken past the wait limit. */
class MigrationLockWaitError extends Error {
  constructor(readonly holder: string | undefined) {
    super("migration lock wait timed out");
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
const SYSTEM_CODE = /^E[A-Z0-9_]+$/;

/** drizzle and the connector wrap driver errors; the code lives somewhere on the cause chain. */
function findCode(
  error: unknown,
  matches: (code: string) => boolean,
): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && matches(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

// No SQLSTATE class starts with "E"; Node system errors (EPIPE, ECONNREFUSED, …) all do.
function sqlStateOf(error: unknown): string | undefined {
  return findCode(error, (code) => SQLSTATE.test(code) && code[0] !== "E");
}

function systemCodeOf(error: unknown): string | undefined {
  return findCode(error, (code) => SYSTEM_CODE.test(code));
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function journalTable(schemaName: string): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(MIGRATIONS_TABLE)}`;
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

/** Every committed migration, in journal order. Fails on a missing file before connecting. */
function readMigrations(folder: string, journal: Journal): MigrationFile[] {
  for (const entry of journal.entries) {
    const file = path.join(folder, `${entry.tag}.sql`);
    if (!fs.existsSync(file)) {
      throw new MigrationFilesError(
        `Missing ${file}, listed in meta/_journal.json. Restore it from version control.`,
      );
    }
  }
  // drizzle-orm's reader, so `hash` matches what drizzle-kit records.
  const files = readMigrationFiles({ migrationsFolder: folder });
  return journal.entries.map((entry, index) => {
    const file = files[index];
    if (!file) {
      throw new MigrationFilesError(
        `Cannot read ${entry.tag}.sql in ${folder}. Restore it from version control.`,
      );
    }
    return {
      tag: entry.tag,
      idx: entry.idx,
      when: entry.when,
      hash: file.hash,
      statements: file.sql,
    };
  });
}

/** The journal table's rows; none when the table does not exist yet. */
async function readRecordedMigrations(
  client: QueryClient,
  schemaName: string,
): Promise<RecordedMigration[]> {
  // pg_catalog needs no privileges, so a missing grant is not mistaken for a missing table.
  const table = await client.query(
    `select 1 from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2`,
    [schemaName, MIGRATIONS_TABLE],
  );
  if (table.rows.length === 0) return [];
  const { rows } = await client.query<{
    hash: string;
    created_at: string | number | null;
  }>(`select hash, created_at from ${journalTable(schemaName)} order by id`);
  return rows.map((row) => ({
    hash: row.hash,
    createdAt: row.created_at === null ? null : Number(row.created_at),
  }));
}

/** Session settings for migrating, each added to `reset` once set. */
async function prepareMigrationSession(
  client: QueryClient,
  reset: string[],
): Promise<void> {
  await client.query("SET statement_timeout = 0");
  reset.push("statement_timeout");
  await client.query(`SET application_name = '${APPLICATION_NAME}'`);
  reset.push("application_name");
  try {
    await client.query(
      `SET client_connection_check_interval = '${CONNECTION_CHECK_INTERVAL}'`,
    );
    reset.push("client_connection_check_interval");
  } catch (error) {
    // Postgres before 14, or a server that cannot poll sockets.
    logger.debug(
      "client_connection_check_interval not set: %s",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** pg_locks splits a bigint advisory key into classid (high 32 bits) and objid (low 32 bits). */
function lockKeyParts(key: string): [string, string] {
  const unsigned = BigInt.asUintN(64, BigInt(key));
  return [(unsigned >> 32n).toString(), (unsigned & 0xffffffffn).toString()];
}

/** "pid 123 (appkit-migrate, active)" for the session holding the migration lock. */
async function migrationLockHolder(
  client: QueryClient,
  key: string,
): Promise<string | undefined> {
  const [classid, objid] = lockKeyParts(key);
  const { rows } = await client.query<{
    pid: number;
    application_name: string | null;
    state: string | null;
  }>(
    `select a.pid, a.application_name, a.state
       from pg_catalog.pg_locks l
       join pg_catalog.pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory' and l.granted
        and l.database = (select d.oid from pg_catalog.pg_database d where d.datname = current_database())
        and l.classid = $1::oid and l.objid = $2::oid and l.objsubid = 1`,
    [classid, objid],
  );
  const holder = rows[0];
  if (!holder) return undefined;
  const details = [holder.application_name, holder.state].filter(Boolean);
  return `pid ${holder.pid}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}

/**
 * Take the per-schema advisory lock, polling so the wait has a limit and the
 * log names the holder. Returns how long it waited.
 */
async function acquireMigrationLock(
  client: QueryClient,
  schemaName: string,
  waitMs: number,
): Promise<number> {
  const key = migrationLockKey(schemaName);
  const started = Date.now();
  let reportAt = started;
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>(
      "select pg_catalog.pg_try_advisory_lock($1::bigint) as locked",
      [key],
    );
    if (rows[0]?.locked) return Date.now() - started;
    const waited = Date.now() - started;
    if (waited >= waitMs || Date.now() >= reportAt) {
      const holder = await migrationLockHolder(client, key).catch(
        () => undefined,
      );
      if (waited >= waitMs) throw new MigrationLockWaitError(holder);
      logger.info(
        "Waiting for another session to finish migrating schema %s (lock held by %s)",
        schemaName,
        holder ?? "an unknown session",
      );
      reportAt = Date.now() + LOCK_REPORT_MS;
    }
    await sleep(Math.min(LOCK_POLL_MS, waitMs - waited));
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

/** drizzle-orm's own journal table, so drizzle-kit reads and extends it too. */
async function ensureJournalTable(
  client: QueryClient,
  schemaName: string,
): Promise<void> {
  await client.query(
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`,
  );
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${journalTable(schemaName)} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`,
  );
}

/** Record a migration the way drizzle-orm's migrator does: its file hash and the journal's `when`. */
async function recordMigration(
  client: QueryClient,
  schemaName: string,
  file: MigrationFile,
): Promise<void> {
  await client.query(
    `insert into ${journalTable(schemaName)} ("hash", "created_at") values($1, $2)`,
    [file.hash, file.when],
  );
}

/**
 * Run one migration and record it in one transaction. A table lock not granted
 * within the lock timeout rolls it back; it is retried LOCK_ATTEMPTS times.
 */
async function applyMigration(
  client: QueryClient,
  schemaName: string,
  file: MigrationFile,
  lockTimeoutMs: number,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await inTransaction(client, async () => {
        await ensureJournalTable(client, schemaName);
        for (const statement of file.statements) {
          if (statement.trim()) await client.query(statement);
        }
        await recordMigration(client, schemaName, file);
      });
      return;
    } catch (error) {
      if (
        attempt >= LOCK_ATTEMPTS ||
        sqlStateOf(error) !== LOCK_NOT_AVAILABLE
      ) {
        throw error;
      }
      logger.warn(
        "Migration %s waited over %dms for a table lock (try %d of %d); retrying",
        file.tag,
        lockTimeoutMs,
        attempt,
        LOCK_ATTEMPTS,
      );
      await sleep(Math.min(attempt * LOCK_POLL_MS, lockTimeoutMs));
    }
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
  baseline: MigrationFile,
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

/** Unlock and reset the session. A connection whose cleanup fails is destroyed, not reused. */
async function releaseMigrationClient(
  client: PoolClient,
  lockKey: string | undefined,
  reset: readonly string[],
): Promise<void> {
  const cleanup: Array<() => Promise<unknown>> = [];
  if (lockKey) {
    cleanup.push(() =>
      client.query("select pg_catalog.pg_advisory_unlock($1::bigint)", [
        lockKey,
      ]),
    );
  }
  for (const name of [...reset].reverse()) {
    cleanup.push(() => client.query(`RESET ${name}`));
  }
  let cleanupError: Error | undefined;
  for (const step of cleanup) {
    try {
      await step();
    } catch (error) {
      cleanupError ??=
        error instanceof Error ? error : new Error(String(error));
    }
  }
  client.release(cleanupError);
}

function tags(files: readonly MigrationFile[]): string[] {
  return files.map((file) => file.tag);
}

function duration(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.round(ms / 60_000);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (ms >= 1_000) return `${Math.round(ms / 1_000)}s`;
  return `${ms}ms`;
}

/**
 * Apply every committed migration the database has not recorded yet.
 *
 * Runs on one connection as the connecting identity, which owns what it
 * creates (see ownership.ts). The recorded history is read first without a
 * lock; only when something is pending does it take the per-schema advisory
 * lock and read again. Each migration then runs and is recorded in its own
 * transaction, so a failure keeps the ones before it.
 *
 * Fails closed, changing nothing, when a committed migration is older than the
 * last recorded one but was never applied. An applied migration whose file
 * changed, and recorded migrations that are not committed, are logged.
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
    return { applied: [], adopted: [], edited: [], unknown: 0, lockWaitMs: 0 };
  }
  const files = readMigrations(options.migrationsFolder, journal);
  const { schemaName } = options;
  const lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  const lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw new MigrationApplyError({
      step: "Connecting to the database",
      cause: error,
    });
  }

  const reset: string[] = [];
  let locked = false;
  const applied: string[] = [];
  const adopted: string[] = [];
  let pending: string[] = [];
  let step = "Reading the recorded migrations";
  let failed: string | undefined;
  try {
    let history = reconcileMigrations(
      files,
      await readRecordedMigrations(client, schemaName),
    );
    let waitedMs = 0;
    if (history.pending.length > 0 && history.stranded.length === 0) {
      pending = tags(history.pending);
      step = "Waiting for the migration lock";
      await prepareMigrationSession(client, reset);
      waitedMs = await acquireMigrationLock(client, schemaName, lockWaitMs);
      locked = true;
      await client.query(`SET lock_timeout = '${lockTimeoutMs}ms'`);
      reset.push("lock_timeout");
      step = "Reading the recorded migrations";
      // Another instance may have applied them while this one waited.
      history = reconcileMigrations(
        files,
        await readRecordedMigrations(client, schemaName),
      );
    }

    if (history.stranded.length > 0) {
      const last =
        files.find((file) => file.when === history.lastRecorded)?.tag ??
        `the migration recorded at ${new Date(history.lastRecorded ?? 0).toISOString()}`;
      throw new MigrationHistoryError(schemaName, tags(history.stranded), last);
    }
    if (history.edited.length > 0) {
      logger.warn(
        "Migrations %s changed after schema %s applied them; the changes never run. Restore the files and put the change in a new migration.",
        tags(history.edited).join(", "),
        schemaName,
      );
    }
    if (history.unknown.length > 0) {
      logger.warn(
        "Schema %s recorded %d migration(s) that are not committed here. A newer release applied them, or their files were deleted.",
        schemaName,
        history.unknown.length,
      );
    }

    const toApply = [...history.pending];
    pending = tags(toApply);
    const baseline = toApply[0];
    if (history.lastRecorded === null && baseline?.tag === BASELINE_TAG) {
      failed = BASELINE_TAG;
      const state = await baselineState(client, options, baseline);
      if (state.kind === "partial") {
        throw new MigrationBaselineMismatchError(schemaName, state.problems);
      }
      if (state.kind === "present") {
        await inTransaction(client, async () => {
          await ensureJournalTable(client, schemaName);
          await recordMigration(client, schemaName, baseline);
        });
        adopted.push(BASELINE_TAG);
        toApply.shift();
        pending.shift();
      }
    }

    for (const file of toApply) {
      failed = file.tag;
      const started = Date.now();
      await applyMigration(client, schemaName, file, lockTimeoutMs);
      applied.push(file.tag);
      pending.shift();
      logger.info(
        "Applied migration %s to schema %s in %dms",
        file.tag,
        schemaName,
        Date.now() - started,
      );
    }
    return {
      applied,
      adopted,
      edited: tags(history.edited),
      unknown: history.unknown.length,
      lockWaitMs: waitedMs,
    };
  } catch (error) {
    if (
      error instanceof MigrationBaselineMismatchError ||
      error instanceof MigrationFilesError ||
      error instanceof MigrationHistoryError
    ) {
      throw error;
    }
    const code = sqlStateOf(error);
    let hint: string | undefined;
    if (error instanceof MigrationLockWaitError) {
      const holder = error.holder
        ? `Session ${error.holder}`
        : "Another session";
      hint = `${holder} held the migration lock for over ${duration(lockWaitMs)}. Deploy again once it finishes; if it is stuck, end it with pg_terminate_backend.`;
    } else if (code === LOCK_NOT_AVAILABLE) {
      hint = `Another session held a lock on a table this migration changes for over ${duration(lockTimeoutMs)}, ${LOCK_ATTEMPTS} times. Deploy again once the long-running query or transaction finishes.`;
    } else if (code === INSUFFICIENT_PRIVILEGE) {
      const ownership = await schemaOwnership(client, schemaName).catch(
        () => undefined,
      );
      hint = ownershipHint(code, ownership);
    }
    throw new MigrationApplyError({
      step,
      failed,
      pending,
      applied,
      adopted,
      hint,
      cause: error,
    });
  } finally {
    await releaseMigrationClient(
      client,
      locked ? migrationLockKey(schemaName) : undefined,
      reset,
    );
  }
}
