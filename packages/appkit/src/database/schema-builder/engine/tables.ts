import {
  type AnyPgColumn,
  bigserial,
  type PgColumnBuilderBase,
  type PgEnum,
  type PgTable,
  bigint as pgBigint,
  boolean as pgBoolean,
  pgEnum,
  integer as pgInteger,
  jsonb as pgJsonb,
  pgSchema,
  pgTable,
  text as pgText,
  timestamp as pgTimestamp,
  uuid as pgUuid,
  varchar as pgVarchar,
  serial,
} from "drizzle-orm/pg-core";

import type { ReferentialAction } from "../../contract";
import { APPKIT_TABLE } from "../private";
import {
  type AppKitTable,
  type ColumnMeta,
  type EngineColumn,
  type MutableColumnMeta,
  SchemaBuildError,
} from "../types";

/** Loosely-typed engine column builder seam */
type AnyColumnBuilder = PgColumnBuilderBase & {
  primaryKey(): AnyColumnBuilder;
  notNull(): AnyColumnBuilder;
  unique(): AnyColumnBuilder;
  default(value: unknown): AnyColumnBuilder;
  defaultNow(): AnyColumnBuilder;
  defaultRandom(): AnyColumnBuilder;
  references(
    ref: () => AnyPgColumn,
    actions?: { onDelete?: ReferentialAction; onUpdate?: ReferentialAction },
  ): AnyColumnBuilder;
};

type PgEnumValues = PgEnum<[string, ...string[]]>;
type EnumRegistry = Map<string, PgEnumValues>;

function getEnum(
  registry: EnumRegistry,
  name: string,
  values: readonly string[],
): PgEnumValues {
  const existing = registry.get(name);
  if (existing) return existing;

  const created = pgEnum(name, values as [string, ...string[]]);
  registry.set(name, created);
  return created;
}

function baseColumn(
  meta: MutableColumnMeta,
  enums: EnumRegistry,
): AnyColumnBuilder {
  const col = meta.columnName;
  let builder: PgColumnBuilderBase;
  switch (meta.storageKind) {
    case "id":
      builder = serial(col);
      break;
    case "bigid":
      builder = bigserial(col, { mode: "bigint" });
      break;
    case "text":
      builder = pgText(col);
      break;
    case "varchar":
      builder = pgVarchar(col, { length: meta.varcharLength ?? 255 });
      break;
    case "integer":
      builder = pgInteger(col);
      break;
    case "bigint":
      builder = pgBigint(col, { mode: "bigint" });
      break;
    case "boolean":
      builder = pgBoolean(col);
      break;
    case "uuid":
      builder = pgUuid(col);
      break;
    case "timestamp":
      builder = pgTimestamp(col, { withTimezone: meta.withTimezone ?? false });
      break;
    case "jsonb":
      builder = pgJsonb(col);
      break;
    case "enum":
      // oxlint-disable-next-line typescript/no-non-null-assertion -- enum metas always carry an enumName.
      builder = getEnum(enums, meta.enumName!, meta.enumValues ?? [])(col);
      break;
  }
  return builder as AnyColumnBuilder;
}

function buildColumn(
  meta: MutableColumnMeta,
  enums: EnumRegistry,
  resolveTarget: (table: string, column: string) => AnyPgColumn,
): PgColumnBuilderBase {
  let c = baseColumn(meta, enums);

  if (meta.primaryKey && !meta.serverGenerated) c = c.primaryKey();
  if (meta.notNull && !meta.serverGenerated) c = c.notNull();
  if (meta.unique) c = c.unique();

  if (!meta.serverGenerated) {
    if (meta.defaultNow) c = c.defaultNow();
    else if (meta.defaultRandom) c = c.defaultRandom();
    else if (meta.defaultValue !== undefined) c = c.default(meta.defaultValue);
  }

  if (meta.fk) {
    const target = meta.fk;
    c = c.references(
      () => resolveTarget(target.targetTable, target.targetColumn),
      { onDelete: target.onDelete, onUpdate: target.onUpdate },
    );
  }

  return c;
}

/**
 * Build one engine table from finalized column metas. `resolveTarget` reads the
 * shared registry so FK `.references()` thunks resolve forward/self refs.
 */
function buildTable(
  name: string,
  schemaName: string,
  metas: Record<string, MutableColumnMeta>,
  enums: EnumRegistry,
  resolveTarget: (table: string, column: string) => AnyPgColumn,
): { engine: PgTable; columns: Record<string, ColumnMeta> } {
  const columnBuilders: Record<string, PgColumnBuilderBase> = {};
  for (const [key, meta] of Object.entries(metas)) {
    columnBuilders[key] = buildColumn(meta, enums, resolveTarget);
  }

  const engine =
    schemaName === "public"
      ? pgTable(name, columnBuilders)
      : pgSchema(schemaName).table(name, columnBuilders);

  const columns: Record<string, ColumnMeta> = {};
  for (const [key, meta] of Object.entries(metas)) {
    // store the real engine column behind the opaque handle (quarantine file).
    meta.engineColumn = (engine as unknown as Record<string, AnyPgColumn>)[
      key
    ] as unknown as EngineColumn;
    columns[key] = meta as ColumnMeta;
  }

  return { engine, columns };
}

function makeAppKitTable(
  name: string,
  schemaName: string,
  built: { engine: PgTable; columns: Record<string, ColumnMeta> },
): AppKitTable {
  return {
    $name: name,
    $schemaName: schemaName,
    $columns: built.columns,
    $engine: built.engine,
    $relations: [],
    [APPKIT_TABLE]: true,
  } as unknown as AppKitTable;
}

/**
 * Build every engine table from finalized metas, resolving FK targets across the
 * whole set via a shared registry so forward/self references wire correctly.
 */
export function buildEngineTables(
  raw: Iterable<{ name: string; metas: Record<string, MutableColumnMeta> }>,
  schemaName: string,
): Record<string, AppKitTable> {
  const builtEngine: Record<string, Record<string, AnyPgColumn>> = {};
  const resolveTarget = (table: string, column: string): AnyPgColumn => {
    const t = builtEngine[table];
    if (!t || !t[column])
      throw new SchemaBuildError(
        `Cannot resolve FK target "${table}.${column}"`,
      );

    return t[column];
  };

  const enums: EnumRegistry = new Map();
  const tables: Record<string, AppKitTable> = {};
  for (const { name, metas } of raw) {
    const built = buildTable(name, schemaName, metas, enums, resolveTarget);
    builtEngine[name] = built.engine as unknown as Record<string, AnyPgColumn>;
    tables[name] = makeAppKitTable(name, schemaName, built);
  }
  return tables;
}
