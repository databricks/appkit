import {
  type ColumnTypeSpec,
  type ColumnValueKind,
  type MutableColumnMeta,
  type ReferentialAction,
  SchemaBuildError,
  type StorageKind,
} from "./types";
import { columnValueSchema } from "./validators";

const REFERENTIAL_ACTIONS = new Set<ReferentialAction>([
  "cascade",
  "set null",
  "set default",
  "restrict",
  "no action",
]);
const MAX_VARCHAR_LENGTH = 10_485_760;

function specStorageKind(spec: ColumnTypeSpec): StorageKind {
  return spec.kind === "fk" ? "integer" : spec.kind;
}

function validateVarcharLength(length: number): void {
  if (!Number.isInteger(length) || length < 1 || length > MAX_VARCHAR_LENGTH) {
    throw new SchemaBuildError(
      `varchar() length must be an integer between 1 and ${MAX_VARCHAR_LENGTH}`,
    );
  }
}

function validateEnum(
  name: string,
  values: readonly string[],
): readonly string[] {
  if (!name) throw new SchemaBuildError("enum() requires a name");
  if (values.length === 0) {
    throw new SchemaBuildError(`enum("${name}") requires at least one value`);
  }
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new SchemaBuildError(
      `enum("${name}") values must be non-empty strings`,
    );
  }
  if (new Set(values).size !== values.length) {
    throw new SchemaBuildError(`enum("${name}") declares duplicate values`);
  }
  return Object.freeze([...values]);
}

function validateReferentialAction(action: ReferentialAction): void {
  if (!REFERENTIAL_ACTIONS.has(action)) {
    throw new SchemaBuildError("Unsupported referential action");
  }
}

interface DefaultValidationTable {
  readonly name: string;
  readonly metas: Readonly<Record<string, MutableColumnMeta>>;
}

function isCompatibleLiteralDefault(meta: MutableColumnMeta): boolean {
  switch (meta.storageKind) {
    case "id":
    case "bigid":
    case "bigint":
    case "jsonb":
      return false;
    default:
      return columnValueSchema(meta).safeParse(meta.defaultValue).success;
  }
}

/** FK literals wait until finalization because fk() inherits target storage. */
export function validateLiteralDefaults(
  tables: Iterable<DefaultValidationTable>,
): void {
  for (const table of tables) {
    for (const meta of Object.values(table.metas)) {
      if (
        Object.hasOwn(meta, "defaultValue") &&
        !isCompatibleLiteralDefault(meta)
      ) {
        throw new SchemaBuildError(
          `Default for column "${table.name}.${meta.columnName}" is not compatible with ${meta.storageKind} storage`,
        );
      }
    }
  }
}

/** Mutable DSL builder; table() clones its metadata before finalization. */
export class ColumnBuilder {
  /** @internal */ readonly _meta: MutableColumnMeta;
  private readonly declarationKind: ColumnTypeSpec["kind"];

  constructor(spec: ColumnTypeSpec, kind: ColumnValueKind) {
    this.declarationKind = spec.kind;
    const enumValues =
      spec.kind === "enum"
        ? validateEnum(spec.enumName, spec.values)
        : undefined;

    const serverGenerated = spec.kind === "id" || spec.kind === "bigid";
    this._meta = {
      name: "",
      columnName: "",
      kind,
      storageKind: specStorageKind(spec),
      notNull: serverGenerated,
      primaryKey: serverGenerated,
      unique: false,
      isPrivate: false,
      serverGenerated,
      hasDefault: serverGenerated,
      withTimezone: spec.kind === "timestamp" ? spec.withTimezone : undefined,
      varcharLength: spec.kind === "varchar" ? spec.length : undefined,
      enumName: spec.kind === "enum" ? spec.enumName : undefined,
      enumValues,
    };
  }

  /** @internal Clone declaration state so builder reuse cannot mutate a table. */
  _cloneMeta(): MutableColumnMeta {
    return {
      ...this._meta,
      enumValues: this._meta.enumValues
        ? Object.freeze([...this._meta.enumValues])
        : undefined,
      fk: this._meta.fk ? { ...this._meta.fk } : undefined,
    };
  }

  notNull(): this {
    this._meta.notNull = true;
    return this;
  }

  primaryKey(): this {
    this._meta.primaryKey = true;
    this._meta.notNull = true;
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

  default(value: string | number | boolean): this {
    this.requireNoDefault();
    this._meta.hasDefault = true;
    this._meta.defaultValue = value;
    return this;
  }

  defaultNow(): this {
    this.requireNoDefault();
    if (this.declarationKind !== "timestamp") {
      throw new SchemaBuildError(
        ".defaultNow() is only valid on timestamp columns",
      );
    }
    this._meta.hasDefault = true;
    this._meta.defaultNow = true;
    return this;
  }

  defaultRandom(): this {
    this.requireNoDefault();
    if (this.declarationKind !== "uuid") {
      throw new SchemaBuildError(
        ".defaultRandom() is only valid on uuid columns",
      );
    }
    this._meta.hasDefault = true;
    this._meta.defaultRandom = true;
    return this;
  }

  onDelete(action: ReferentialAction): this {
    this.requireFk("onDelete");
    validateReferentialAction(action);
    this._meta.onDelete = action;
    return this;
  }

  onUpdate(action: ReferentialAction): this {
    this.requireFk("onUpdate");
    validateReferentialAction(action);
    this._meta.onUpdate = action;
    return this;
  }

  private requireNoDefault(): void {
    if (this._meta.hasDefault) {
      throw new SchemaBuildError("A column may declare only one default mode");
    }
  }

  private requireFk(modifier: string): void {
    if (this.declarationKind !== "fk") {
      throw new SchemaBuildError(
        `.${modifier}() is only valid on fk() columns`,
      );
    }
  }
}

export const id = () => new ColumnBuilder({ kind: "id" }, "number");
export const bigid = () => new ColumnBuilder({ kind: "bigid" }, "bigint");
export const text = () => new ColumnBuilder({ kind: "text" }, "string");
export const varchar = (length = 255) => {
  validateVarcharLength(length);
  return new ColumnBuilder({ kind: "varchar", length }, "string");
};
export const integer = () => new ColumnBuilder({ kind: "integer" }, "number");
export const bigint = () => new ColumnBuilder({ kind: "bigint" }, "bigint");
export const boolean = () => new ColumnBuilder({ kind: "boolean" }, "boolean");
export const uuid = () => new ColumnBuilder({ kind: "uuid" }, "uuid");
export const timestamp = (opts?: { withTimezone?: boolean }) => {
  const withTimezone = opts?.withTimezone ?? false;
  return new ColumnBuilder({ kind: "timestamp", withTimezone }, "date");
};
export const jsonb = () => new ColumnBuilder({ kind: "jsonb" }, "json");

export function enumColumn(name: string, values: readonly string[]) {
  return new ColumnBuilder({ kind: "enum", enumName: name, values }, "enum");
}
