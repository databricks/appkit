import {
  DatabasePluginError,
  invalidDatabaseInput,
} from "../../../database/errors";
import type { IdValue, Row, ScalarValue } from "../../../database/runtime";
import type { CompiledColumn, JsonValue } from "./codecs";
import { boundedJson, type CrudTable, isPlainObject } from "./contract";

/**
 * Decode a path identifier against the declared key type. A keyless table gets
 * no `/:id` route, so arriving here without a key is a wiring fault, not input.
 */
export function decodeId(table: CrudTable, raw: string): IdValue {
  const { primaryKey } = table;
  if (!primaryKey) throw new DatabasePluginError("INTERNAL", "read");
  const value = primaryKey.decode(raw);
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "bigint"
  ) {
    throw invalidDatabaseInput(["id"], "Not a valid identifier");
  }
  return value;
}

/** Map one body value onto its column; `undefined` when it does not fit. */
function decodeWriteValue(
  column: CompiledColumn,
  raw: unknown,
): ScalarValue | JsonValue | undefined {
  if (raw === null) return column.meta.notNull ? undefined : null;
  if (column.meta.kind !== "json") return column.decode(raw);
  try {
    // JSON columns accept any JSON the response budget can carry back.
    return boundedJson(raw);
  } catch {
    return undefined;
  }
}

/** Decode one untrusted body against the columns this operation may set. */
function decodeBody(
  table: CrudTable,
  writable: ReadonlySet<string>,
  raw: unknown,
): Row {
  if (!isPlainObject(raw)) {
    throw invalidDatabaseInput(["body"], "Expected a JSON object");
  }
  const values: Row = {};
  for (const [key, value] of Object.entries(raw)) {
    // Private, server-generated, and unknown fields are refused, not dropped.
    const column = writable.has(key) ? table.columns.get(key) : undefined;
    if (!column) {
      // Naming the field echoes caller input, so only a public name is named.
      throw invalidDatabaseInput(
        table.selectable.has(key) ? [key] : ["body"],
        "Unknown or read-only field",
      );
    }
    const decoded = decodeWriteValue(column, value);
    if (decoded === undefined) {
      throw invalidDatabaseInput([key], "Does not match the column type");
    }
    values[key] = decoded;
  }
  return values;
}

/** Decode the body of `POST /:table`, which may carry a caller-chosen key. */
export function decodeCreateBody(table: CrudTable, raw: unknown): Row {
  return decodeBody(table, table.creatable, raw);
}

/** Decode the body of `PATCH /:table/:id`, which may not carry a key or stamp. */
export function decodeUpdateBody(table: CrudTable, raw: unknown): Row {
  return decodeBody(table, table.updatable, raw);
}
