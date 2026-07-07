import type { ColumnInfoKind, ReferentialAction } from "../contract";
import {
  type ColumnTypeSpec,
  type MutableColumnMeta,
  SchemaBuildError,
  type StorageKind,
} from "./types";

const SERVER_GENERATED = new Set<ColumnTypeSpec["kind"]>(["id", "bigid"]);

function specStorageKind(spec: ColumnTypeSpec): StorageKind {
  return spec.kind === "fk" ? "integer" : spec.kind;
}

function stampDefaultExpr(value: string | number | boolean): string {
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export class ColumnBuilder {
  /** @internal */ readonly _spec: ColumnTypeSpec;
  /** @internal */ readonly _meta: MutableColumnMeta;

  constructor(spec: ColumnTypeSpec, pgType: string, kind: ColumnInfoKind) {
    const serverGenerated = SERVER_GENERATED.has(spec.kind);
    this._spec = spec;
    this._meta = {
      name: "",
      columnName: "",
      kind,
      pgType,
      storageKind: specStorageKind(spec),
      notNull: false,
      primaryKey: serverGenerated,
      unique: false,
      isPrivate: false,
      isOwner: false,
      serverGenerated,
      hasDefault: serverGenerated,
      withTimezone: spec.kind === "timestamp" ? spec.withTimezone : undefined,
      varcharLength: spec.kind === "varchar" ? spec.length : undefined,
      enumName: spec.kind === "enum" ? spec.enumName : undefined,
      enumValues: spec.kind === "enum" ? spec.values : undefined,
    };
  }

  notNull(): this {
    this._meta.notNull = true;
    return this;
  }

  primaryKey(): this {
    this._meta.primaryKey = true;
    return this;
  }

  unique(): this {
    this._meta.unique = true;
    return this;
  }

  private(): this {
    this._meta.isPrivate = true;
    return this;
  }

  owner(): this {
    this._meta.isOwner = true;
    return this;
  }

  default(value: string | number | boolean): this {
    this._meta.hasDefault = true;
    this._meta.defaultExpr = stampDefaultExpr(value);
    this._meta.defaultValue = value;
    return this;
  }

  defaultNow(): this {
    this._meta.hasDefault = true;
    this._meta.defaultExpr = "now()";
    this._meta.defaultNow = true;
    return this;
  }

  defaultRandom(): this {
    this._meta.hasDefault = true;
    this._meta.defaultExpr = "gen_random_uuid()";
    this._meta.defaultRandom = true;
    return this;
  }

  onDelete(action: ReferentialAction): this {
    this.requireFk("onDelete");
    this._meta.onDelete = action;
    return this;
  }

  onUpdate(action: ReferentialAction): this {
    this.requireFk("onUpdate");
    this._meta.onUpdate = action;
    return this;
  }

  private requireFk(modifier: string): void {
    if (this._spec.kind !== "fk") {
      throw new SchemaBuildError(
        `.${modifier}() is only valid on fk() columns`,
      );
    }
  }
}

export const id = () => new ColumnBuilder({ kind: "id" }, "int4", "number");
export const bigid = () =>
  new ColumnBuilder({ kind: "bigid" }, "int8", "bigint");
export const text = () => new ColumnBuilder({ kind: "text" }, "text", "string");
export const varchar = (length = 255) =>
  new ColumnBuilder({ kind: "varchar", length }, "varchar", "string");
export const integer = () =>
  new ColumnBuilder({ kind: "integer" }, "int4", "number");
export const bigint = () =>
  new ColumnBuilder({ kind: "bigint" }, "int8", "bigint");
export const boolean = () =>
  new ColumnBuilder({ kind: "boolean" }, "bool", "boolean");
export const uuid = () => new ColumnBuilder({ kind: "uuid" }, "uuid", "uuid");
export const timestamp = (opts?: { withTimezone?: boolean }) => {
  const withTimezone = opts?.withTimezone ?? false;
  return new ColumnBuilder(
    { kind: "timestamp", withTimezone },
    withTimezone ? "timestamptz" : "timestamp",
    "date",
  );
};
export const jsonb = () =>
  new ColumnBuilder({ kind: "jsonb" }, "jsonb", "json");

export function enumColumn(name: string, values: readonly string[]) {
  if (!values || values.length === 0) {
    throw new SchemaBuildError(
      `enumColumn("${name}") requires at least one value`,
    );
  }
  return new ColumnBuilder(
    { kind: "enum", enumName: name, values },
    name,
    "enum",
  );
}
