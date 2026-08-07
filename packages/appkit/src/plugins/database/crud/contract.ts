import {
  DatabasePluginError,
  invalidDatabaseInput,
} from "../../../database/errors";
import type { IdValue, Row } from "../../../database/runtime";
import type { AppKitTable } from "../../../database/schema-builder";
import { filterOperatorsForKind } from "../../../database/schema-builder/types";
import { MAX_SERIALIZED_DEPTH, MAX_SERIALIZED_NODES } from "../defaults";
import { type CompiledColumn, compileColumn, type JsonValue } from "./codecs";

/** One relation edge wired to the contract of its target table. */
export interface CrudRelation {
  readonly cardinality: "toOne" | "toMany";
  readonly target: CrudTable;
}

/** Private HTTP contract compiled once for one explicitly exposed table. */
export interface CrudTable {
  readonly name: string;
  readonly primaryKey?: CompiledColumn;
  readonly columns: ReadonlyMap<string, CompiledColumn>;
  /** Public columns a request may project. */
  readonly selectable: ReadonlySet<string>;
  /** Public columns a request may filter or order by. */
  readonly queryable: ReadonlySet<string>;
  readonly relations: ReadonlyMap<string, CrudRelation>;
  decodeId(raw: string): IdValue;
  projectPublicRow(row: Row): JsonValue;
  sanitizeSerializedRow(row: unknown): JsonValue;
}

type MutableCrudTable = Omit<CrudTable, "relations"> & {
  readonly relations: Map<string, CrudRelation>;
};

interface SanitizeState {
  nodes: number;
  readonly ancestors: Set<object>;
}

/** A bare object literal; a `Date`, class instance, or `Map` is not JSON. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A serializer that breaks its contract is trusted code failing, not input. */
function serializerFault(): never {
  throw new DatabasePluginError("INTERNAL", "read");
}

/** Charge one value against the output budget before descending into it. */
function countNode(depth: number, state: SanitizeState): void {
  state.nodes += 1;
  if (state.nodes > MAX_SERIALIZED_NODES || depth > MAX_SERIALIZED_DEPTH) {
    serializerFault();
  }
}

/** Walk a container while its ancestors are tracked, so a cycle cannot pass. */
function enterObject<T>(
  value: object,
  state: SanitizeState,
  visit: () => T,
): T {
  if (state.ancestors.has(value)) serializerFault();
  state.ancestors.add(value);
  try {
    return visit();
  } finally {
    state.ancestors.delete(value);
  }
}

/** Accept a serializer's own added value only where it is already JSON. */
function sanitizeJson(
  value: unknown,
  depth: number,
  state: SanitizeState,
): JsonValue {
  countNode(depth, state);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) serializerFault();
    return value;
  }
  if (Array.isArray(value)) {
    return enterObject(value, state, () =>
      value.map((item) => sanitizeJson(item, depth + 1, state)),
    );
  }
  if (!isPlainObject(value)) serializerFault();
  return enterObject(value, state, () => {
    // A null prototype keeps `__proto__` an ordinary key instead of a setter.
    const out: Record<string, JsonValue> = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      out[key] = sanitizeJson(child, depth + 1, state);
    }
    return out;
  });
}

/** Keep an included row under its own table's policy, one row or many. */
function sanitizeRelation(
  target: CrudTable,
  value: unknown,
  depth: number,
  state: SanitizeState,
): JsonValue {
  if (value === null) return null;
  if (!Array.isArray(value)) return sanitizeRow(target, value, depth, state);
  countNode(depth, state);
  return enterObject(value, state, () =>
    value.map((row) => sanitizeRow(target, row, depth + 1, state)),
  );
}

/** Re-apply the private-column policy wherever the output stays contracted. */
function sanitizeRow(
  table: CrudTable,
  row: unknown,
  depth: number,
  state: SanitizeState,
): JsonValue {
  countNode(depth, state);
  if (!isPlainObject(row)) serializerFault();
  return enterObject(row, state, () => {
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(row)) {
      if (child === undefined) continue;
      if (table.columns.get(key)?.meta.isPrivate) continue;
      const relation = table.relations.get(key);
      out[key] = relation
        ? sanitizeRelation(relation.target, child, depth + 1, state)
        : sanitizeJson(child, depth + 1, state);
    }
    return out;
  });
}

/** Project an included row through its own table; absent to-one reads null. */
function projectRelation(target: CrudTable, value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  return Array.isArray(value)
    ? value.map((row) => target.projectPublicRow(row as Row))
    : target.projectPublicRow(value as Row);
}

/** Build the public JSON for one driver row, dropping anything uncontracted. */
function projectRow(table: CrudTable, row: Row): JsonValue {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(row)) {
    const column = table.columns.get(key);
    if (column) {
      // Whatever the driver returned, only public contracted columns ship.
      if (!column.meta.isPrivate) out[key] = column.encode(value);
      continue;
    }
    const relation = table.relations.get(key);
    if (relation) out[key] = projectRelation(relation.target, value);
  }
  return out;
}

/** Compile one table's allowlists and codecs from its finalized metadata. */
function compileTable(table: AppKitTable): MutableCrudTable {
  const columns = new Map<string, CompiledColumn>();
  const selectable = new Set<string>();
  const queryable = new Set<string>();
  let primaryKey: CompiledColumn | undefined;

  for (const meta of Object.values(table.$columns)) {
    const column = compileColumn(meta);
    columns.set(meta.columnName, column);
    if (meta.primaryKey) primaryKey = column;
    if (meta.isPrivate) continue;
    selectable.add(meta.columnName);
    if (filterOperatorsForKind(meta.kind).length > 0) {
      queryable.add(meta.columnName);
    }
  }

  const compiled: MutableCrudTable = {
    name: table.$name,
    primaryKey,
    columns,
    selectable,
    queryable,
    relations: new Map(),
    decodeId: (raw) => {
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
    },
    projectPublicRow: (row) => projectRow(compiled, row),
    sanitizeSerializedRow: (row) =>
      sanitizeRow(compiled, row, 0, { nodes: 0, ancestors: new Set() }),
  };
  return compiled;
}

/**
 * Compile the HTTP contract for every exposed table and wire the relations
 * they share. A relation whose target is not exposed stays unreachable, so
 * enabling one table never widens another table's public surface.
 */
export function compileCrudTables(
  tables: Record<string, AppKitTable>,
): Map<string, CrudTable> {
  const compiled = new Map<string, MutableCrudTable>();
  for (const table of Object.values(tables)) {
    compiled.set(table.$name, compileTable(table));
  }
  for (const table of Object.values(tables)) {
    const entry = compiled.get(table.$name);
    for (const relation of table.$relations) {
      const target = compiled.get(relation.targetTable);
      if (!entry || !target) continue;
      entry.relations.set(relation.name, {
        cardinality: relation.cardinality,
        target,
      });
    }
  }
  return compiled as Map<string, CrudTable>;
}
