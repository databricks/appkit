import { ColumnBuilder } from "./columns";
import {
  type ColumnRef,
  type FkRef,
  type MutableColumnMeta,
  SchemaBuildError,
  type StorageKind,
} from "./types";

/** Declare foreign-key to another column. */
export function fk(ref: FkRef): ColumnBuilder {
  const builder = new ColumnBuilder({ kind: "fk" }, "number");
  builder._meta.fkRef = ref;
  return builder;
}

export function resolveFkRef(ref: FkRef): ColumnRef {
  const resolved = typeof ref === "function" ? ref() : ref;
  if (
    !resolved ||
    typeof resolved !== "object" ||
    resolved.__isColumnRef !== true
  ) {
    throw new SchemaBuildError(
      "fk() must reference a column created by table()",
    );
  }
  return resolved;
}

/** A serial PK target stores as its plain integer type on the FK side. */
export function mirrorStorageKind(targetStorage: StorageKind): StorageKind {
  if (targetStorage === "id") return "integer";
  if (targetStorage === "bigid") return "bigint";
  return targetStorage;
}

interface ForeignKeyTable {
  readonly name: string;
  readonly metas: Readonly<Record<string, MutableColumnMeta>>;
  readonly handle: Readonly<Record<string, ColumnRef>>;
}

/** Resolve FK identity, inherited storage, and action invariants in one pass. */
export function resolveForeignKeys(
  tables: ReadonlyMap<string, ForeignKeyTable>,
): void {
  const references = new Map<
    ColumnRef,
    { readonly table: ForeignKeyTable; readonly meta: MutableColumnMeta }
  >();
  for (const table of tables.values()) {
    for (const [columnName, reference] of Object.entries(table.handle)) {
      const meta = table.metas[columnName];
      if (!meta) {
        throw new SchemaBuildError(
          `Column reference "${table.name}.${columnName}" has no metadata`,
        );
      }
      references.set(reference, { table, meta });
    }
  }

  const resolving = new Set<MutableColumnMeta>();
  const resolved = new Set<MutableColumnMeta>();

  const resolveForeignKey = (
    table: ForeignKeyTable,
    meta: MutableColumnMeta,
  ): void => {
    if (!meta.fkRef || resolved.has(meta)) return;
    if (resolving.has(meta)) {
      throw new SchemaBuildError(
        `Foreign key "${table.name}.${meta.columnName}" has a cyclic storage dependency`,
      );
    }

    resolving.add(meta);
    try {
      const reference = resolveFkRef(meta.fkRef);
      const targetIdentity = references.get(reference);
      if (!targetIdentity) {
        throw new SchemaBuildError(
          `fk() on "${table.name}.${meta.columnName}" targets a column outside the returned schema`,
        );
      }

      const { table: targetTable, meta: target } = targetIdentity;
      resolveForeignKey(targetTable, target);
      if (!target.primaryKey && !target.unique) {
        throw new SchemaBuildError(
          `fk() on "${table.name}.${meta.columnName}" must target a primary-key or unique column`,
        );
      }

      meta.storageKind = mirrorStorageKind(target.storageKind);
      meta.kind = target.kind;
      meta.withTimezone = target.withTimezone;
      meta.varcharLength = target.varcharLength;
      meta.enumName = target.enumName;
      meta.enumValues = target.enumValues
        ? Object.freeze([...target.enumValues])
        : undefined;
      meta.fk = {
        targetTable: targetTable.name,
        targetColumn: target.columnName,
        onDelete: meta.onDelete,
        onUpdate: meta.onUpdate,
      };

      const actions = [meta.onDelete, meta.onUpdate];
      if (actions.includes("set null") && meta.notNull) {
        throw new SchemaBuildError(
          `Foreign key "${table.name}.${meta.columnName}" uses SET NULL but is not-null`,
        );
      }
      if (actions.includes("set default") && !meta.hasDefault) {
        throw new SchemaBuildError(
          `Foreign key "${table.name}.${meta.columnName}" uses SET DEFAULT without a local default`,
        );
      }
      resolved.add(meta);
    } finally {
      resolving.delete(meta);
    }
  };

  for (const table of tables.values()) {
    for (const meta of Object.values(table.metas)) {
      resolveForeignKey(table, meta);
    }
  }
}
