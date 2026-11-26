import fs from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = "config/database/migrations";
export const MIGRATIONS_TABLE = "__drizzle_migrations";
export const BASELINE_TAG = "0000_baseline";

export interface JournalEntry {
  idx: number;
  version: "7";
  when: number;
  tag: string;
  breakpoints: true;
}

export interface Journal {
  version: "7";
  dialect: "postgresql";
  entries: JournalEntry[];
}

export function migrationsFolder(root: string): string {
  return path.resolve(root, MIGRATIONS_DIR);
}

// drizzle-kit 0.31's v7 folder layout. drizzle-kit v1 replaces it with one
// folder per migration, so every path into the folder is built here.

/** Folder of the journal and the snapshots. */
export function metaFolder(folder: string): string {
  return path.join(folder, "meta");
}

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

export class MigrationFilesError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationFilesError";
  }
}

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

export function readJournal(folder: string): Journal | null {
  const file = journalFile(folder);
  if (!fs.existsSync(file)) return null;
  return parseJournal(readJsonFile<unknown>(file), file);
}
