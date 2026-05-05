import type { AppKitTable } from "./types";

/**
 * Returns the column names of `table` that are NOT marked `.private()`.
 */
export function nonPrivateColumnNames(table: AppKitTable): string[] {
  const out: string[] = [];
  for (const [name, meta] of Object.entries(table.$columns)) {
    if (meta.private !== true) out.push(name);
  }
  return out;
}

/**
 * Returns the column names of `table` that ARE marked `.private()`.
 */
export function privateColumnNames(table: AppKitTable): string[] {
  const out: string[] = [];
  for (const [name, meta] of Object.entries(table.$columns)) {
    if (meta.private === true) out.push(name);
  }
  return out;
}

/**
 * Returns true if `columnName` is marked `.private()` on `table`.
 */
export function isPrivateColumn(
  table: AppKitTable,
  columnName: string,
): boolean {
  return table.$columns[columnName]?.private === true;
}
