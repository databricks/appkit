import type { AppKitTable, ColumnMeta } from "./types";

/** Marker proving an object is an Appkit-built table */
export const APPKIT_TABLE = Symbol.for("appkit.database.table");

export function isPrivateColumn(meta: ColumnMeta): boolean {
  return meta.isPrivate;
}

export function privateColumnNames(table: AppKitTable): string[] {
  return Object.values(table.$columns)
    .filter(isPrivateColumn)
    .map((c) => c.columnName);
}

export function nonPrivateColumnNames(table: AppKitTable): string[] {
  return Object.values(table.$columns)
    .filter((c) => !isPrivateColumn(c))
    .map((c) => c.columnName);
}

/**
 * The RLS owner column name (`.owner()`), if one is declared.
 */
export function ownerColumnName(table: AppKitTable): string | undefined {
  return Object.values(table.$columns).find((c) => c.isOwner)?.columnName;
}
