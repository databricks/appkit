import type { ZodType } from "zod";
import { z } from "zod";
import type { AppKitTable, ColumnMeta } from "./types";

/** Map an engine-neutral ColumnMeta.kind to a Zod base type */
function zodForColumn(meta: ColumnMeta): ZodType {
  switch (meta.kind) {
    case "string":
    case "uuid":
      return z.string();
    case "number":
      return z.number();
    case "bigint":
      return z.union([z.bigint(), z.number(), z.string()]);
    case "boolean":
      return z.boolean();
    case "date":
      return z.union([z.date(), z.string()]);
    case "json":
      return z.unknown();
    case "enum":
      return meta.enumValues && meta.enumValues.length > 0
        ? z.enum([...meta.enumValues] as [string, ...string[]])
        : z.string();
    default:
      return z.unknown();
  }
}

/** Insert payload: omit private + server-generated; */
export function deriveInsertSchema(tables: AppKitTable): ZodType {
  const shape: Record<string, ZodType> = {};

  for (const meta of Object.values(tables.$columns)) {
    if (meta.isPrivate || meta.serverGenerated) continue;
    let field = zodForColumn(meta);

    if (!meta.notNull) field = field.nullable();
    if (!meta.notNull || meta.hasDefault) field = field.optional();
    shape[meta.columnName] = field;
  }

  return z.object(shape);
}

/** Update payload: omit PK + private + server-generated; every field optional (partial). */
export function deriveUpdateSchema(tables: AppKitTable): ZodType {
  const shape: Record<string, ZodType> = {};
  for (const meta of Object.values(tables.$columns)) {
    if (meta.isPrivate || meta.serverGenerated || meta.primaryKey) continue;
    let field = zodForColumn(meta);
    if (!meta.notNull) field = field.nullable();
    shape[meta.columnName] = field.optional();
  }
  return z.object(shape);
}
