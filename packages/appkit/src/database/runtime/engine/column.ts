import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { AppKitTable } from "../../schema-builder";
import { DataPathError } from "../data-path";

export function colOf(table: AppKitTable, key: string): AnyPgColumn {
  const meta = table.$columns[key];

  if (!meta || !meta.engineColumn)
    throw new DataPathError(`Unknown column "${table.$name}.${key}"`);

  return meta.engineColumn as unknown as AnyPgColumn;
}
