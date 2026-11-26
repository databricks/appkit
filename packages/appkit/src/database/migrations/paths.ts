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

export function metaFolder(folder: string): string {
  return path.join(folder, "meta");
}

export function journalFile(folder: string): string {
  return path.join(metaFolder(folder), "_journal.json");
}

export function migrationPrefix(idx: number): string {
  return String(idx).padStart(4, "0");
}

export function migrationFile(folder: string, tag: string): string {
  return path.join(folder, `${tag}.sql`);
}

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

export function parseJournal(json: unknown, nameInError: string): Journal {
  const parsed = json as Partial<Journal> | null;
  if (parsed?.dialect !== "postgresql" || !Array.isArray(parsed.entries)) {
    throw new MigrationFilesError(
      `${nameInError} is not a drizzle-kit PostgreSQL migration journal`,
    );
  }
  return parsed as Journal;
}

export function readJournal(folder: string): Journal | null {
  const file = journalFile(folder);
  if (!fs.existsSync(file)) return null;
  return parseJournal(readJsonFile<unknown>(file), file);
}
