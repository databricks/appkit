import { type AppKitTable, privateColumnNames } from "../schema-builder";
import type { Row } from "./data-path";

/** Default relational `columns` map that DROPS private columns.
 *  Used when a query supplies no explicit `select`, so `.private()` columns are excluded
 *  by default.
 */
export function defaultColumns(table: AppKitTable): Record<string, true> {
  const priv = new Set(privateColumnNames(table));
  const columns: Record<string, true> = {};

  for (const meta of Object.values(table.$columns)) {
    if (!priv.has(meta.columnName)) columns[meta.columnName] = true;
  }

  return columns;
}

/** Strip private columns from a row. */
export function stripPrivate(table: AppKitTable, row: Row): Row {
  const priv = privateColumnNames(table);
  if (priv.length === 0) return row;

  const out = { ...row };
  for (const c of priv) delete out[c];
  return out;
}
