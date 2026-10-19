/** A committed migration: its journal entry plus what drizzle-orm reads from its .sql file. */
export interface MigrationFile {
  readonly tag: string;
  readonly idx: number;
  /** The journal's `when`, recorded as `created_at`. */
  readonly when: number;
  /** sha256 of the .sql file, recorded as `hash`. */
  readonly hash: string;
  /** The file split on `--> statement-breakpoint`. */
  readonly statements: readonly string[];
}

/** One row of the journal table. */
export interface RecordedMigration {
  readonly hash: string;
  readonly createdAt: number | null;
}

/** Committed migrations compared with what the database recorded. */
interface MigrationHistory {
  /** Not recorded and newer than every recorded migration: applied next, oldest first. */
  readonly pending: readonly MigrationFile[];
  /** Not recorded but older than the last recorded migration, so a later one ran first. */
  readonly stranded: readonly MigrationFile[];
  /** Recorded, but the committed file changed since; the change never runs. */
  readonly edited: readonly MigrationFile[];
  /** Recorded rows no committed migration matches: a newer release ran, or files were deleted. */
  readonly unknown: readonly RecordedMigration[];
  /** `created_at` of the newest recorded migration; null when none is. */
  readonly lastRecorded: number | null;
}

/**
 * Match each committed migration with a recorded row by `when` = `created_at`,
 * the pair drizzle-orm's migrator writes, then compare hashes.
 */
export function reconcileMigrations(
  files: readonly MigrationFile[],
  recorded: readonly RecordedMigration[],
): MigrationHistory {
  const hashAt = new Map<number, string>();
  for (const row of recorded) {
    if (row.createdAt !== null) hashAt.set(row.createdAt, row.hash);
  }
  const lastRecorded = hashAt.size > 0 ? Math.max(...hashAt.keys()) : null;

  const pending: MigrationFile[] = [];
  const stranded: MigrationFile[] = [];
  const edited: MigrationFile[] = [];
  for (const file of files) {
    const hash = hashAt.get(file.when);
    if (hash === undefined) {
      if (lastRecorded === null || file.when > lastRecorded) pending.push(file);
      else stranded.push(file);
    } else if (hash !== file.hash) {
      edited.push(file);
    }
  }
  const committed = new Set(files.map((file) => file.when));
  const unknown = recorded.filter(
    (row) => row.createdAt === null || !committed.has(row.createdAt),
  );
  return { pending, stranded, edited, unknown, lastRecorded };
}
