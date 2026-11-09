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

/**
 * Committed migrations at one `when` that cannot be paired one to one with
 * the rows recorded at it: more than one of each, or one file with several
 * rows, none matching by hash.
 */
export interface AmbiguousTimestamp {
  readonly when: number;
  /** Committed at `when`, none with a recorded hash. */
  readonly files: readonly MigrationFile[];
  /** Rows recorded at `when`, none with a committed hash. */
  readonly recorded: number;
}

/** Committed migrations compared with what the database recorded. */
interface MigrationHistory {
  /** Not recorded and newer than every recorded migration: applied next, oldest first. */
  readonly pending: readonly MigrationFile[];
  /** Not recorded but older than the last recorded migration, so a later one ran first. */
  readonly stranded: readonly MigrationFile[];
  /** Recorded, but the committed file changed since; the change never runs. */
  readonly edited: readonly MigrationFile[];
  /** Timestamps where the files and rows left after exact matches cannot be paired. */
  readonly ambiguous: readonly AmbiguousTimestamp[];
  /** Recorded rows no committed migration matches: a newer release ran, or files were deleted. */
  readonly unknown: readonly RecordedMigration[];
  /** `created_at` of the newest recorded migration; null when none is. */
  readonly lastRecorded: number | null;
}

type Classified = "pending" | "stranded" | "edited";

function groupBy<T>(
  items: readonly T[],
  key: (item: T) => number,
): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const item of items) {
    const group = groups.get(key(item)) ?? [];
    group.push(item);
    groups.set(key(item), group);
  }
  return groups;
}

/**
 * Match committed migrations with recorded rows by `when` = `created_at`,
 * the pair drizzle-orm's migrator writes, one row per file. Two entries can
 * share a `when` after a hand edit or a merge, so each `when` is reconciled
 * as a bucket: exact hash matches are consumed first, then one file left
 * with one row left is an edited migration. Files left with no row are
 * pending or stranded; rows left with no file are unknown. Any other
 * remainder is ambiguous, for the caller to refuse rather than guess.
 */
export function reconcileMigrations(
  files: readonly MigrationFile[],
  recorded: readonly RecordedMigration[],
): MigrationHistory {
  const rowsAt = groupBy(
    recorded.filter((row) => row.createdAt !== null),
    (row) => row.createdAt as number,
  );
  const lastRecorded = rowsAt.size > 0 ? Math.max(...rowsAt.keys()) : null;

  const kind = new Map<MigrationFile, Classified>();
  const accounted = new Set<RecordedMigration>();
  const ambiguous: AmbiguousTimestamp[] = [];
  for (const [when, bucket] of groupBy(files, (file) => file.when)) {
    const rows = [...(rowsAt.get(when) ?? [])];
    const unmatched: MigrationFile[] = [];
    for (const file of bucket) {
      const match = rows.findIndex((row) => row.hash === file.hash);
      if (match === -1) unmatched.push(file);
      else accounted.add(rows.splice(match, 1)[0] as RecordedMigration);
    }
    if (unmatched.length === 0) continue;
    if (rows.length === 0) {
      const left =
        lastRecorded === null || when > lastRecorded ? "pending" : "stranded";
      for (const file of unmatched) kind.set(file, left);
    } else if (unmatched.length === 1 && rows.length === 1) {
      kind.set(unmatched[0] as MigrationFile, "edited");
      accounted.add(rows[0] as RecordedMigration);
    } else {
      ambiguous.push({ when, files: unmatched, recorded: rows.length });
      for (const row of rows) accounted.add(row);
    }
  }

  const of = (classified: Classified) =>
    files.filter((file) => kind.get(file) === classified);
  return {
    pending: of("pending"),
    stranded: of("stranded"),
    edited: of("edited"),
    ambiguous,
    unknown: recorded.filter((row) => !accounted.has(row)),
    lastRecorded,
  };
}
