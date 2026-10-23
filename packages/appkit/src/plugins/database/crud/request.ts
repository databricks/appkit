import { invalidDatabaseInput } from "../../../database/errors";
import type { Row, ScalarValue } from "../../../database/runtime";
import type { CompiledColumn, JsonValue } from "./codecs";
import { boundedJson, type CrudTable, isPlainObject } from "./contract";

/** Map one body value onto its column; `undefined` when it does not fit. */
function decodeWriteValue(
  column: CompiledColumn,
  raw: unknown,
): ScalarValue | JsonValue | undefined {
  if (raw === null) return column.meta.notNull ? undefined : null;
  if (column.meta.kind !== "json") return column.decode(raw);
  try {
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

/** Decode a create body, which may carry a caller-chosen key. */
export function decodeCreateBody(table: CrudTable, raw: unknown): Row {
  return decodeBody(table, table.creatable, raw);
}

/** Decode an update body, which may not carry a key or stamp. */
export function decodeUpdateBody(table: CrudTable, raw: unknown): Row {
  return decodeBody(table, table.updatable, raw);
}
