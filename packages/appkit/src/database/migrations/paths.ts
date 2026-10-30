import fs from "node:fs";
import path from "node:path";

/** Committed migration history, relative to the application root. */
const MIGRATIONS_DIR = "config/database/migrations";
/** Journal table drizzle-orm's migrator keeps in the app schema. */
export const MIGRATIONS_TABLE = "__drizzle_migrations";
/**
 * First migration `appkit db introspect` writes for tables that already exist.
 * The migrator adopts it (records it without running it) when the catalog
 * already holds every one of its tables and columns.
 */
export const BASELINE_TAG = "0000_baseline";

/** One entry of drizzle-kit's v7 `meta/_journal.json`. */
export interface JournalEntry {
  idx: number;
  version: "7";
  when: number;
  tag: string;
  breakpoints: true;
}

/** drizzle-kit's v7 `meta/_journal.json`. */
export interface Journal {
  version: "7";
  dialect: "postgresql";
  entries: JournalEntry[];
}

/** Absolute migrations folder for an application root. */
export function migrationsFolder(root: string): string {
  return path.resolve(root, MIGRATIONS_DIR);
}

// drizzle-kit 0.31's v7 folder layout. drizzle-kit v1 replaces it with one
// folder per migration, so every path into the folder is built here.

/** Folder of the journal and the snapshots. */
export function metaFolder(folder: string): string {
  return path.join(folder, "meta");
}

/** Path of the journal inside a migrations folder. */
export function journalFile(folder: string): string {
  return path.join(metaFolder(folder), "_journal.json");
}

/** The `NNNN` that starts the tag of the migration at journal index idx. */
export function migrationPrefix(idx: number): string {
  return String(idx).padStart(4, "0");
}

/** Path of a migration's SQL. */
export function migrationFile(folder: string, tag: string): string {
  return path.join(folder, `${tag}.sql`);
}

/** Path of the snapshot written with the migration at journal index idx. */
export function snapshotFile(folder: string, idx: number): string {
  return path.join(metaFolder(folder), `${migrationPrefix(idx)}_snapshot.json`);
}

/** A committed migration file is missing or unreadable; the message names the file. */
export class MigrationFilesError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationFilesError";
  }
}

/** Parse a committed JSON file of the migration history. */
export function readJsonFile<T>(file: string): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch (error) {
    throw new MigrationFilesError(
      `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}. Restore it from version control.`,
      { cause: error },
    );
  }
}

/** A parsed meta/_journal.json, checked to be drizzle-kit's PostgreSQL journal; label names it in the error. */
export function parseJournal(json: unknown, label: string): Journal {
  const parsed = json as Partial<Journal> | null;
  if (parsed?.dialect !== "postgresql" || !Array.isArray(parsed.entries)) {
    throw new MigrationFilesError(
      `${label} is not a drizzle-kit PostgreSQL migration journal`,
    );
  }
  return parsed as Journal;
}

/** null when meta/_journal.json is absent (nothing committed yet). */
export function readJournal(folder: string): Journal | null {
  const file = journalFile(folder);
  if (!fs.existsSync(file)) return null;
  return parseJournal(readJsonFile<unknown>(file), file);
}
