import { DatabasePluginError } from "../../../database/errors";
import type { AppKitTable } from "../../../database/schema-builder";
import { isPlainObject as hasPlainObjectPrototype } from "../../../utils/is-plain-object";
import { MAX_SERIALIZED_DEPTH, MAX_SERIALIZED_NODES } from "../defaults";
import { columnHttpCapabilities } from "./capabilities";
import { type CompiledColumn, compileColumn, type JsonValue } from "./codecs";

/** Private HTTP contract compiled once for one table. */
export interface CrudTable {
  readonly primaryKey?: CompiledColumn;
  readonly columns: ReadonlyMap<string, CompiledColumn>;
  /** Public columns: every column that is not private. */
  readonly selectable: ReadonlySet<string>;
  /** Public columns a create body may set, including a caller-chosen key. */
  readonly creatable: ReadonlySet<string>;
  /** Public columns an update body may set; a key or a stamp is never one. */
  readonly updatable: ReadonlySet<string>;
}

interface SanitizeState {
  nodes: number;
  readonly ancestors: Set<object>;
}

/** A bare object literal; a `Date`, class instance, or `Map` is not JSON. */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return hasPlainObjectPrototype(value);
}

function rejectUnboundedJson(): never {
  throw new DatabasePluginError("INVALID_REQUEST", "write");
}

function countNode(depth: number, state: SanitizeState): void {
  state.nodes += 1;
  if (state.nodes > MAX_SERIALIZED_NODES || depth > MAX_SERIALIZED_DEPTH) {
    rejectUnboundedJson();
  }
}

/** Walk a container while its ancestors are tracked, so a cycle cannot pass. */
function enterObject<T>(
  value: object,
  state: SanitizeState,
  visit: () => T,
): T {
  if (state.ancestors.has(value)) rejectUnboundedJson();
  state.ancestors.add(value);
  try {
    return visit();
  } finally {
    state.ancestors.delete(value);
  }
}

/** Accept caller JSON only where it is already a finite JSON value. */
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
    if (!Number.isFinite(value)) rejectUnboundedJson();
    return value;
  }
  if (Array.isArray(value)) {
    return enterObject(value, state, () =>
      value.map((item) => sanitizeJson(item, depth + 1, state)),
    );
  }
  if (!isPlainObject(value)) rejectUnboundedJson();
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

/** Copy finite acyclic JSON, bounded by depth and node count. */
export function boundedJson(value: unknown): JsonValue {
  return sanitizeJson(value, 0, { nodes: 0, ancestors: new Set() });
}

/** Compile one table's allowlists and codecs from its finalized metadata. */
function compileTable(table: AppKitTable): CrudTable {
  const columns = new Map<string, CompiledColumn>();
  const selectable = new Set<string>();
  const creatable = new Set<string>();
  const updatable = new Set<string>();
  let primaryKey: CompiledColumn | undefined;

  for (const meta of Object.values(table.$columns)) {
    const column = compileColumn(meta);
    columns.set(meta.columnName, column);
    // Type generation reads the same predicates for the browser's types.
    const can = columnHttpCapabilities(meta);
    if (can.publicKey) primaryKey = column;
    if (can.selectable) selectable.add(meta.columnName);
    if (can.creatable) creatable.add(meta.columnName);
    if (can.updatable) updatable.add(meta.columnName);
  }

  return { primaryKey, columns, selectable, creatable, updatable };
}

/** Compile the HTTP contract of every table, keyed by table name. */
export function compileCrudTables(
  tables: Record<string, AppKitTable>,
): Map<string, CrudTable> {
  return new Map(
    Object.values(tables).map(
      (table) => [table.$name, compileTable(table)] as const,
    ),
  );
}
