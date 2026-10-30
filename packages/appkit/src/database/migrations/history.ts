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
 * the pair drizzle-orm's migrator writes, then compare hashes. Two entries can
 * share a `when` after a hand edit or a merge, so each `when` keeps every hash
 * recorded at it.
 */
export function reconcileMigrations(
  files: readonly MigrationFile[],
  recorded: readonly RecordedMigration[],
): MigrationHistory {
  const hashesAt = new Map<number, Set<string>>();
  for (const row of recorded) {
    if (row.createdAt === null) continue;
    const hashes = hashesAt.get(row.createdAt) ?? new Set<string>();
    hashes.add(row.hash);
    hashesAt.set(row.createdAt, hashes);
  }
  const lastRecorded = hashesAt.size > 0 ? Math.max(...hashesAt.keys()) : null;

  const pending: MigrationFile[] = [];
  const stranded: MigrationFile[] = [];
  const edited: MigrationFile[] = [];
  for (const file of files) {
    const hashes = hashesAt.get(file.when);
    if (hashes?.has(file.hash)) continue;
    // A row at this `when` that is another entry's: this one never ran.
    const sibling = files.some(
      (other) =>
        other !== file && other.when === file.when && hashes?.has(other.hash),
    );
    if (hashes && !sibling) edited.push(file);
    else if (lastRecorded === null || file.when > lastRecorded) {
      pending.push(file);
    } else stranded.push(file);
  }
  const committed = new Set(files.map((file) => file.when));
  const unknown = recorded.filter(
    (row) => row.createdAt === null || !committed.has(row.createdAt),
  );
  return { pending, stranded, edited, unknown, lastRecorded };
}
