import {
  type AnyPgColumn,
  type PgColumnBuilderBase,
  type PgEnum,
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
} from "drizzle-orm/pg-core";
import {
  type EngineTable,
  type MutableColumnMeta,
  type ReferentialAction,
  SchemaBuildError,
} from "../types";

type AnyColumnBuilder = PgColumnBuilderBase & {
  primaryKey(): AnyColumnBuilder;
  notNull(): AnyColumnBuilder;
  unique(): AnyColumnBuilder;
  default(value: unknown): AnyColumnBuilder;
  defaultNow(): AnyColumnBuilder;
  defaultRandom(): AnyColumnBuilder;
  generatedByDefaultAsIdentity(): AnyColumnBuilder;
  references(
    ref: () => AnyPgColumn,
    actions?: { onDelete?: ReferentialAction; onUpdate?: ReferentialAction },
  ): AnyColumnBuilder;
};

type PgEnumValues = PgEnum<[string, ...string[]]>;
/** Reuse one Drizzle enum object for each enum name in this schema. */
type EnumRegistry = Map<string, PgEnumValues>;

interface BuiltEngineTable {
  readonly engine: EngineTable;
  readonly columns: Record<string, MutableColumnMeta>;
}

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function getEnum(
  registry: EnumRegistry,
  schemaName: string,
  name: string,
  values: readonly string[],
): PgEnumValues {
  const existing = registry.get(name);
  if (existing) {
    if (!sameValues(existing.enumValues, values)) {
      throw new SchemaBuildError(
        `Enum "${name}" is declared with conflicting values`,
      );
    }
    return existing;
  }

  const tuple = values as [string, ...string[]];
  const created =
    schemaName === "public"
      ? pgEnum(name, tuple)
      : pgSchema(schemaName).enum(name, tuple);
  registry.set(name, created as PgEnumValues);
  return created as PgEnumValues;
}

/** Map resolved storage metadata to its Drizzle column builder. */
function baseColumn(
  meta: MutableColumnMeta,
  schemaName: string,
  enums: EnumRegistry,
): AnyColumnBuilder {
  const name = meta.columnName;
  let builder: PgColumnBuilderBase;
  switch (meta.storageKind) {
    case "id":
    case "integer":
      builder = pgInteger(name);
      break;
    case "bigid":
    case "bigint":
      builder = pgBigint(name, { mode: "bigint" });
      break;
    case "text":
      builder = pgText(name);
      break;
    case "varchar":
      builder = pgVarchar(name, { length: meta.varcharLength ?? 255 });
      break;
    case "boolean":
      builder = pgBoolean(name);
      break;
    case "uuid":
      builder = pgUuid(name);
      break;
    case "timestamp":
      builder = pgTimestamp(name, {
        mode: "string",
        withTimezone: meta.withTimezone ?? false,
      });
      break;
    case "jsonb":
      builder = pgJsonb(name);
      break;
    case "enum": {
      if (!meta.enumName || !meta.enumValues?.length) {
        throw new SchemaBuildError(
          `Enum column "${meta.columnName}" has no enum definition`,
        );
      }
      builder = getEnum(
        enums,
        schemaName,
        meta.enumName,
        meta.enumValues,
      )(name);
      break;
    }
  }
  return builder as AnyColumnBuilder;
}

function buildColumn(
  meta: MutableColumnMeta,
  schemaName: string,
  enums: EnumRegistry,
  resolveTarget: (table: string, column: string) => AnyPgColumn,
): PgColumnBuilderBase {
  let column = baseColumn(meta, schemaName, enums);
  if (meta.serverGenerated) column = column.generatedByDefaultAsIdentity();
  if (meta.primaryKey) column = column.primaryKey();
  else if (meta.notNull) column = column.notNull();
  if (meta.unique) column = column.unique();

  if (!meta.serverGenerated) {
    if (meta.defaultNow) column = column.defaultNow();
    else if (meta.defaultRandom) column = column.defaultRandom();
    else if (Object.hasOwn(meta, "defaultValue")) {
      column = column.default(meta.defaultValue);
    }
  }

  if (meta.fk) {
    const target = meta.fk;
    // Drizzle resolves this thunk after all referenced tables are registered.
    column = column.references(
      () => resolveTarget(target.targetTable, target.targetColumn),
      { onDelete: target.onDelete, onUpdate: target.onUpdate },
    );
  }
  return column;
}

// PostgreSQL renders a timestamp as `2026-06-29 19:05:19.051709+00` over the
// text protocol but as ISO-8601 inside the JSON aggregates Drizzle builds for
// relations, so one column reaches callers in two shapes depending on whether
// it was included. Both shapes are declared `string`, and only ISO-8601 parses
// per the ECMAScript grammar, so normalize to it.
const PG_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:([+-]\d{2})(?::?(\d{2}))?)?$/;

function isoTimestamp(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const parts = PG_TIMESTAMP.exec(value);
  // Leave `infinity`, `-infinity`, and anything unrecognized untouched.
  if (!parts) return value;
  const [, date, time, offsetHours, offsetMinutes] = parts;
  const offset =
    offsetHours === undefined ? "" : `${offsetHours}:${offsetMinutes ?? "00"}`;
  return `${date}T${time}${offset}`;
}

function buildTable(
  name: string,
  schemaName: string,
  metas: Record<string, MutableColumnMeta>,
  enums: EnumRegistry,
  resolveTarget: (table: string, column: string) => AnyPgColumn,
): BuiltEngineTable {
  const columnBuilders: Record<string, PgColumnBuilderBase> =
    Object.create(null);
  for (const [key, meta] of Object.entries(metas)) {
    columnBuilders[key] = buildColumn(meta, schemaName, enums, resolveTarget);
  }

  const engine =
    schemaName === "public"
      ? pgTable(name, columnBuilders)
      : pgSchema(schemaName).table(name, columnBuilders);
  for (const [key, meta] of Object.entries(metas)) {
    const engineColumn = (engine as unknown as Record<string, AnyPgColumn>)[
      key
    ];
    if (!engineColumn) {
      throw new SchemaBuildError(
        `Engine column "${name}.${key}" was not constructed`,
      );
    }
    if (meta.storageKind === "timestamp") {
      // Drizzle routes every read path through this decoder, so overriding it
      // covers direct selects, relation includes, and mutation RETURNING alike.
      (engineColumn as unknown as Record<string, unknown>).mapFromDriverValue =
        isoTimestamp;
    }
    meta.engineColumn =
      engineColumn as unknown as MutableColumnMeta["engineColumn"];
  }
  return { engine: engine as unknown as EngineTable, columns: metas };
}

/** Build all Drizzle tables only after declaration validation has succeeded. */
export function buildEngineTables(
  raw: Iterable<{ name: string; metas: Record<string, MutableColumnMeta> }>,
  schemaName: string,
): Map<string, BuiltEngineTable> {
  const entries = [...raw];
  const builtEngine = new Map<string, Record<string, AnyPgColumn>>();
  const resolveTarget = (table: string, column: string): AnyPgColumn => {
    const target = builtEngine.get(table)?.[column];
    if (!target) {
      throw new SchemaBuildError(
        `Cannot resolve FK target "${table}.${column}"`,
      );
    }
    return target;
  };

  const enums: EnumRegistry = new Map();
  const tables = new Map<string, BuiltEngineTable>();
  for (const { name, metas } of entries) {
    const built = buildTable(name, schemaName, metas, enums, resolveTarget);
    builtEngine.set(
      name,
      built.engine as unknown as Record<string, AnyPgColumn>,
    );
    tables.set(name, built);
  }
  return tables;
}
