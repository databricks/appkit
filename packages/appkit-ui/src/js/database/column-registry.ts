import type { ColumnInfo } from "./types";

/**
 * Process-wide map populated by the typegen-emitted `database.columns.ts`.
 * `db.<entity>.columns()` reads here; the database plugin no longer relies on
 * a runtime `_columns` metadata route.
 */
let registered: Record<string, readonly ColumnInfo[]> = {};

/** Called by generated code at module load. */
export function registerDatabaseColumns(
  columns: Record<string, readonly ColumnInfo[]>,
): void {
  registered = columns;
}

/** Internal — `client.columns()` only. */
export function getRegisteredColumns(
  entity: string,
): readonly ColumnInfo[] | undefined {
  return registered[entity];
}
