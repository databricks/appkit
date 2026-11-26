export interface MigrationFile {
  readonly tag: string;
  readonly idx: number;
  readonly when: number;
  readonly hash: string;
  readonly hashes: readonly string[];
  readonly statements: readonly string[];
}

export interface RecordedMigration {
  readonly hash: string;
  readonly createdAt: number | null;
}

export interface AmbiguousTimestamp {
  readonly when: number;
  readonly files: readonly MigrationFile[];
  readonly recorded: number;
}

export interface MigrationHistory {
  readonly pending: readonly MigrationFile[];
  readonly stranded: readonly MigrationFile[];
  readonly edited: readonly MigrationFile[];
  readonly ambiguous: readonly AmbiguousTimestamp[];
  readonly unknown: readonly RecordedMigration[];
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
      const match = rows.findIndex((row) => file.hashes.includes(row.hash));
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
