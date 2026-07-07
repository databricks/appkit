import { ColumnBuilder } from "./columns";
import { buildEngineTables } from "./engine/tables";
import { mirrorStorageKind, resolveFkRef } from "./fk";
import { buildRelations } from "./relations";
import {
  type AppKitTable,
  type ColumnRef,
  type DefineSchemaOptions,
  type MutableColumnMeta,
  type Schema,
  SchemaBuildError,
  type TableHandle,
} from "./types";
import { deriveInsertSchema, deriveUpdateSchema } from "./validators";

interface RawTable {
  name: string;
  metas: Record<string, MutableColumnMeta>;
  handle: AppKitTable & Record<string, ColumnRef>;
}

export interface SchemaBuilderContext {
  table<C extends Record<string, ColumnBuilder>>(
    name: string,
    columns: C,
  ): TableHandle<C>;
  enum(name: string, values: readonly string[]): ColumnBuilder;
}

export function defineSchema(
  builder: (ctx: SchemaBuilderContext) => Record<string, AppKitTable>,
  options?: DefineSchemaOptions,
): Schema {
  const schemaName = options?.schemaName ?? "public";
  const raw = new Map<string, RawTable>();

  const ctx: SchemaBuilderContext = {
    table(name, columns) {
      if (raw.has(name))
        throw new SchemaBuildError(`Duplicate table "${name}"`);
      const metas: Record<string, MutableColumnMeta> = {};
      const handle = {} as AppKitTable & Record<string, ColumnRef>;

      for (const [key, col] of Object.entries(columns)) {
        col._meta.name = key;
        col._meta.columnName = key;
        metas[key] = col._meta;
        Object.defineProperty(handle, key, {
          enumerable: true,
          value: {
            __isColumnRef: true,
            tableName: name,
            columnName: key,
          } satisfies ColumnRef,
        });
      }

      const ownerColumns = Object.values(metas).filter((meta) => meta.isOwner);
      if (ownerColumns.length > 1) {
        const ownerNames = ownerColumns
          .map((meta) => meta.columnName)
          .join(", ");
        throw new SchemaBuildError(
          `Table "${name}" declares multiple .owner() columns (${ownerNames}). Only one owner column is supported.`,
        );
      }

      raw.set(name, { name, metas, handle });
      return handle as TableHandle<typeof columns>;
    },
    enum(name, values) {
      if (values.length === 0) {
        throw new SchemaBuildError(
          `enum("${name}") requires at least one value`,
        );
      }

      return new ColumnBuilder(
        { kind: "enum", enumName: name, values },
        name,
        "enum",
      );
    },
  };

  const returned = builder(ctx);

  // resolve FKs
  for (const { name, metas } of raw.values()) {
    for (const meta of Object.values(metas)) {
      if (!meta.fkRef) continue;
      const ref = resolveFkRef(meta.fkRef);
      const target = raw.get(ref.tableName);

      if (!target)
        throw new SchemaBuildError(
          `fk() on "${name}.${meta.columnName}" targets unknown table "${ref.tableName}"`,
        );

      const targetMeta = target.metas[ref.columnName];
      if (!targetMeta)
        throw new SchemaBuildError(
          `fk() on "${name}.${meta.columnName}" targets unknown column "${ref.tableName}.${ref.columnName}"`,
        );

      meta.storageKind = mirrorStorageKind(targetMeta.storageKind);
      meta.pgType =
        targetMeta.storageKind === "bigid" ? "int8" : targetMeta.pgType;
      meta.kind = targetMeta.kind === "bigint" ? "bigint" : targetMeta.kind;
      if (meta.storageKind === "integer") meta.pgType = "int4";
      if (meta.storageKind === "bigint") meta.pgType = "int8";

      meta.fk = {
        targetTable: ref.tableName,
        targetColumn: ref.columnName,
        onDelete: meta.onDelete,
        onUpdate: meta.onUpdate,
      };
    }
  }

  // build engine tables
  const built = buildEngineTables(raw.values(), schemaName);
  const tables: Record<string, AppKitTable> = {};
  for (const { name, handle } of raw.values()) {
    // Upgrade the handle in place so `defineSchema`'s return + column refs share it.
    Object.assign(handle, built[name]);
    tables[name] = handle;
  }

  buildRelations(tables);

  // Map the returned keys back to the built handles (returned values ARE handles).
  const byHandle = new Map<AppKitTable, string>();
  for (const [name, t] of Object.entries(tables)) {
    byHandle.set(t, name);
    t.$insertSchema = deriveInsertSchema(t);
    t.$updateSchema = deriveUpdateSchema(t);
  }
  const result: Record<string, AppKitTable> = {};
  for (const [key, value] of Object.entries(returned)) {
    const name = byHandle.get(value);
    if (!name)
      throw new SchemaBuildError(
        `defineSchema returned a value for "${key}" that was not produced by ctx.table()`,
      );

    result[key] = value;
  }

  const engineMap: Schema["$engine"] = {};
  for (const [key, t] of Object.entries(result)) engineMap[key] = t.$engine;

  return {
    $schemaName: schemaName,
    $tables: result,
    $engine: engineMap,
  };
}
