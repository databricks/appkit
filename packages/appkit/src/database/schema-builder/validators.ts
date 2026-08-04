import type { ZodType } from "zod";
import { z } from "zod";
import type { AppKitTable, ColumnMeta } from "./types";

const PG_INTEGER_MIN = -2_147_483_648;
const PG_INTEGER_MAX = 2_147_483_647;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate the canonical value shape accepted by the configured Drizzle column. */
export function columnValueSchema(
  meta: Pick<
    ColumnMeta,
    "kind" | "storageKind" | "varcharLength" | "enumValues"
  >,
): ZodType {
  switch (meta.kind) {
    case "string": {
      const value = z.string();
      return meta.storageKind === "varchar"
        ? value.max(meta.varcharLength ?? 255)
        : value;
    }
    case "number":
      return z.number().int().min(PG_INTEGER_MIN).max(PG_INTEGER_MAX);
    case "bigint":
      return z.bigint();
    case "boolean":
      return z.boolean();
    case "date":
      return z.iso.datetime({ local: true, offset: true });
    case "json":
      return z.json();
    case "uuid":
      return z.string().regex(UUID_RE);
    case "enum":
      return meta.enumValues && meta.enumValues.length > 0
        ? z.enum([...meta.enumValues] as [string, ...string[]])
        : z.never();
    default:
      return z.never();
  }
}

/** Trusted insert payload: private fields are allowed; identities are not. */
export function deriveInsertSchema(tables: AppKitTable): ZodType {
  const shape: Record<string, ZodType> = {};

  for (const meta of Object.values(tables.$columns)) {
    if (meta.serverGenerated) continue;
    let field = columnValueSchema(meta);

    if (!meta.notNull) field = field.nullable();
    if (!meta.notNull || meta.hasDefault) field = field.optional();
    shape[meta.columnName] = field;
  }

  return z.strictObject(shape);
}

/** Trusted update payload: private fields are allowed; keys and identities are not. */
export function deriveUpdateSchema(tables: AppKitTable): ZodType {
  const shape: Record<string, ZodType> = {};
  for (const meta of Object.values(tables.$columns)) {
    if (meta.serverGenerated || meta.primaryKey) continue;
    let field = columnValueSchema(meta);
    if (!meta.notNull) field = field.nullable();
    shape[meta.columnName] = field.optional();
  }
  return z.strictObject(shape);
}
