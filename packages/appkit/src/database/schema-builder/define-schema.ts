import { ColumnBuilder, enumColumn, validateLiteralDefaults } from "./columns";
import { buildEngineTables } from "./engine/tables";
import { resolveForeignKeys } from "./fk";
import { buildRelations } from "./relations";
import {
  type AppKitTable,
  type ColumnMeta,
  type ColumnRef,
  type DefineSchemaOptions,
  type MutableColumnMeta,
  type ResolvedRelation,
  type Schema,
  SchemaBuildError,
  type TableHandle,
} from "./types";
import { deriveInsertSchema, deriveUpdateSchema } from "./validators";

interface RawTable {
  readonly name: string;
  readonly metas: Record<string, MutableColumnMeta>;
  readonly handle: Record<string, ColumnRef>;
}

interface FinalizedTableCandidate {
  readonly columns: Readonly<Record<string, ColumnMeta>>;
  readonly engine: Schema["$engine"][string];
  readonly relations: readonly ResolvedRelation[];
  readonly insertSchema: unknown;
  readonly updateSchema: unknown;
}

interface DeclarationState {
  readonly raw: Map<string, RawTable>;
  readonly handleNames: Map<object, string>;
}

export interface SchemaBuilderContext {
  table<C extends Record<string, ColumnBuilder>>(
    name: string,
    columns: C,
  ): TableHandle<C>;
  enum(name: string, values: readonly string[]): ColumnBuilder;
}

const RESERVED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const TABLE_METADATA_KEYS = [
  "$name",
  "$schemaName",
  "$columns",
  "$engine",
  "$relations",
  "$insertSchema",
  "$updateSchema",
] as const;

function nullRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function assertRecord(value: unknown, label: string): asserts value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SchemaBuildError(`${label} must be an object`);
  }
}

function assertName(value: string, label: string): void {
  if (!value || RESERVED_OBJECT_KEYS.has(value)) {
    throw new SchemaBuildError(`${label} "${value}" is reserved`);
  }
}

function finalizeColumn(meta: MutableColumnMeta): ColumnMeta {
  if (!meta.engineColumn) {
    throw new SchemaBuildError(
      `Engine column "${meta.columnName}" is missing during finalization`,
    );
  }
  const { fkRef: _fkRef, ...published } = meta;
  return Object.freeze({
    ...published,
    enumValues: meta.enumValues
      ? Object.freeze([...meta.enumValues])
      : undefined,
    fk: meta.fk ? Object.freeze({ ...meta.fk }) : undefined,
    engineColumn: meta.engineColumn,
  }) as ColumnMeta;
}

function finalizeRelations(
  relations: readonly ResolvedRelation[],
): readonly ResolvedRelation[] {
  return Object.freeze(
    relations.map((relation) => Object.freeze({ ...relation })),
  );
}

/** Clone builders into per-table metadata and create stable column handles. */
function declareTable<C extends Record<string, ColumnBuilder>>(
  state: DeclarationState,
  name: string,
  columns: C,
): TableHandle<C> {
  assertName(name, "Table name");
  if (state.raw.has(name)) {
    throw new SchemaBuildError(`Duplicate table "${name}"`);
  }
  assertRecord(columns, `Columns for table "${name}"`);

  const metas = nullRecord<MutableColumnMeta>();
  const handle = Object.create(null) as Record<string, ColumnRef>;
  for (const [key, column] of Object.entries(columns)) {
    assertName(key, `Column name on table "${name}"`);
    if (key.startsWith("$") || key === "and" || key === "or") {
      throw new SchemaBuildError(
        `Column "${name}.${key}" collides with AppKit runtime metadata`,
      );
    }
    if (!(column instanceof ColumnBuilder)) {
      throw new SchemaBuildError(
        `Column "${name}.${key}" was not created by an AppKit column builder`,
      );
    }

    const meta = column._cloneMeta();
    meta.name = key;
    meta.columnName = key;
    metas[key] = meta;

    const reference: ColumnRef = Object.freeze({
      __isColumnRef: true,
      tableName: name,
      columnName: key,
    });
    Object.defineProperty(handle, key, {
      enumerable: true,
      value: reference,
    });
  }

  state.raw.set(name, { name, metas, handle });
  state.handleNames.set(handle, name);
  return handle as unknown as TableHandle<C>;
}

function createBuilderContext(state: DeclarationState): SchemaBuilderContext {
  return {
    table(name, columns) {
      return declareTable(state, name, columns);
    },
    enum(name, values) {
      return enumColumn(name, values);
    },
  };
}

/** Require every exact table handle once under its declared identity. */
function validateReturnedTables(
  returned: unknown,
  state: DeclarationState,
): void {
  assertRecord(returned, "defineSchema() return value");
  const returnedHandles = new Set<object>();
  for (const [key, value] of Object.entries(returned)) {
    const name =
      value !== null && typeof value === "object"
        ? state.handleNames.get(value)
        : undefined;
    if (!name) {
      throw new SchemaBuildError(
        `defineSchema returned a value for "${key}" that was not produced by ctx.table()`,
      );
    }
    if (key !== name) {
      throw new SchemaBuildError(
        `defineSchema returned table "${name}" under key "${key}"; aliases are not supported`,
      );
    }
    if (returnedHandles.has(value)) {
      throw new SchemaBuildError(`Table "${name}" was returned more than once`);
    }
    returnedHandles.add(value);
  }
  if (returnedHandles.size !== state.raw.size) {
    const omitted = [...state.raw.values()]
      .filter((table) => !returnedHandles.has(table.handle))
      .map((table) => table.name);
    throw new SchemaBuildError(
      `defineSchema omitted declared table${omitted.length === 1 ? "" : "s"}: ${omitted.join(", ")}`,
    );
  }
}

/** Detect declaration-handle tampering before metadata publication. */
function validateHandles(raw: ReadonlyMap<string, RawTable>): void {
  for (const table of raw.values()) {
    const ownKeys = Reflect.ownKeys(table.handle);
    const hasOnlyDeclaredColumns =
      ownKeys.length === Object.keys(table.metas).length &&
      ownKeys.every(
        (key) => typeof key === "string" && Object.hasOwn(table.metas, key),
      );
    const hasMetadataCollision = TABLE_METADATA_KEYS.some((key) =>
      Object.hasOwn(table.handle, key),
    );
    if (
      Object.getPrototypeOf(table.handle) !== null ||
      !Object.isExtensible(table.handle) ||
      !hasOnlyDeclaredColumns ||
      hasMetadataCollision
    ) {
      throw new SchemaBuildError(
        `Table handle "${table.name}" was modified during schema declaration`,
      );
    }
  }
}

function validatePrimaryKeys(raw: ReadonlyMap<string, RawTable>): void {
  for (const table of raw.values()) {
    const primaryKeys = Object.values(table.metas).filter(
      (meta) => meta.primaryKey,
    );
    if (primaryKeys.length > 1) {
      throw new SchemaBuildError(
        `Table "${table.name}" declares multiple primary-key columns; composite primary keys are not supported`,
      );
    }
  }
}

function validateRelationKeys(
  raw: ReadonlyMap<string, RawTable>,
  relations: ReadonlyMap<string, readonly ResolvedRelation[]>,
): void {
  for (const [name, tableRelations] of relations) {
    if (tableRelations.length > 0 && raw.has(`${name}Relations`)) {
      throw new SchemaBuildError(
        `Table "${name}Relations" collides with generated relation metadata for "${name}"`,
      );
    }
  }
}

/** Prepare every engine object and validator without mutating handles. */
function prepareTables(
  raw: ReadonlyMap<string, RawTable>,
  schemaName: string,
  relations: ReadonlyMap<string, readonly ResolvedRelation[]>,
): Map<string, FinalizedTableCandidate> {
  const built = buildEngineTables(raw.values(), schemaName);
  const candidates = new Map<string, FinalizedTableCandidate>();
  for (const table of raw.values()) {
    const builtTable = built.get(table.name);
    if (!builtTable) {
      throw new SchemaBuildError(
        `Engine table "${table.name}" was not constructed`,
      );
    }
    const columns = nullRecord<ColumnMeta>();
    for (const [key, meta] of Object.entries(builtTable.columns)) {
      columns[key] = finalizeColumn(meta);
    }
    Object.freeze(columns);
    const tableRelations = finalizeRelations(relations.get(table.name) ?? []);
    const validatorTable = { $columns: columns } as AppKitTable;
    candidates.set(table.name, {
      columns,
      engine: builtTable.engine,
      relations: tableRelations,
      insertSchema: deriveInsertSchema(validatorTable),
      updateSchema: deriveUpdateSchema(validatorTable),
    });
  }
  return candidates;
}

/** Atomically publish prepared metadata as the final schema transition. */
function publishSchema(
  raw: ReadonlyMap<string, RawTable>,
  candidates: ReadonlyMap<string, FinalizedTableCandidate>,
  schemaName: string,
): Schema {
  const publications = [...raw.values()].map((table) => {
    const candidate = candidates.get(table.name);
    if (!candidate) {
      throw new SchemaBuildError(
        `Table "${table.name}" was not prepared for finalization`,
      );
    }
    return { table, candidate };
  });

  const tables = nullRecord<AppKitTable>();
  const engine = nullRecord<Schema["$engine"][string]>();
  for (const { table, candidate } of publications) {
    Object.defineProperties(table.handle, {
      $name: { value: table.name },
      $schemaName: { value: schemaName },
      $columns: { value: candidate.columns },
      $engine: { value: candidate.engine },
      $relations: { value: candidate.relations },
      $insertSchema: { value: candidate.insertSchema },
      $updateSchema: { value: candidate.updateSchema },
    });
    const finalized = Object.freeze(table.handle) as unknown as AppKitTable;
    tables[table.name] = finalized;
    engine[table.name] = candidate.engine;
  }

  return Object.freeze({
    $schemaName: schemaName,
    $tables: Object.freeze(tables),
    $engine: Object.freeze(engine),
  });
}

export function defineSchema(
  builder: (context: SchemaBuilderContext) => Record<string, AppKitTable>,
  options?: DefineSchemaOptions,
): Schema {
  const schemaName = options?.schemaName ?? "public";
  if (!schemaName) throw new SchemaBuildError("Schema name cannot be empty");

  const state: DeclarationState = {
    raw: new Map(),
    handleNames: new Map(),
  };
  const returned = builder(createBuilderContext(state));

  validateReturnedTables(returned, state);
  validateHandles(state.raw);
  validatePrimaryKeys(state.raw);
  resolveForeignKeys(state.raw);
  // FK literals are checked against the inherited target storage, not the placeholder.
  validateLiteralDefaults(state.raw.values());

  const relations = buildRelations(state.raw);
  validateRelationKeys(state.raw, relations);
  const candidates = prepareTables(state.raw, schemaName, relations);
  return publishSchema(state.raw, candidates, schemaName);
}
