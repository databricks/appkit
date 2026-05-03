import {
  bigint as pgBigint,
  bigserial as pgBigserial,
  boolean as pgBoolean,
  pgEnum,
  integer as pgInteger,
  jsonb as pgJsonb,
  text as pgText,
  timestamp as pgTimestamp,
  uuid as pgUuid,
  varchar as pgVarchar,
  serial,
} from "drizzle-orm/pg-core";
import { ValidationError } from "../../errors";
import type {
  AppKitColumn,
  AppKitColumnChain,
  ColumnKind,
  ColumnMeta,
  FkColumnChain,
  Relation,
} from "./types";

/**
 * Wrap a column builder with a chain of methods.
 * This is used to build the column schema.
 * @param builder - The column builder to wrap.
 * @param meta - The metadata for the column.
 * @returns The wrapped column chain.
 */
function wrap(builder: unknown, meta: ColumnMeta = {}): AppKitColumnChain {
  const column: AppKitColumn = { $builder: builder, $meta: meta };

  const chain: AppKitColumnChain = Object.assign(column, {
    notNull() {
      column.$builder = (
        column.$builder as { notNull: () => unknown }
      ).notNull();
      return chain;
    },
    unique() {
      column.$builder = (column.$builder as { unique: () => unknown }).unique();
      return chain;
    },
    primaryKey() {
      column.$builder = (
        column.$builder as { primaryKey: () => unknown }
      ).primaryKey();
      // Stamp meta so derivePkColumn / $updateSchema PK omit don't have to
      // round-trip through the Drizzle table to discover this is a PK.
      column.$meta.primaryKey = true;
      return chain;
    },
    default<T>(value: T) {
      column.$builder = (
        column.$builder as { default: (value: T) => unknown }
      ).default(value);
      return chain;
    },
    defaultNow() {
      column.$builder = (
        column.$builder as { defaultNow: () => unknown }
      ).defaultNow();
      column.$meta.serverGenerated = true;
      return chain;
    },
    defaultRandom() {
      column.$builder = (
        column.$builder as { defaultRandom: () => unknown }
      ).defaultRandom();
      column.$meta.serverGenerated = true;
      return chain;
    },
    private() {
      column.$meta.private = true;
      return chain;
    },
  });

  return chain;
}

/**
 * Create an int4 (serial) primary-key column.
 *
 * Maps to Postgres `serial` (4-byte integer with an attached sequence). Use
 * `bigid()` for tables that need more than ~2 billion rows or that mirror an
 * existing `bigserial` column from a brownfield database.
 */
export function id(): AppKitColumnChain {
  return wrap(serial().primaryKey(), {
    serverGenerated: true,
    primaryKey: true,
    pgKind: "serial",
  });
}

/**
 * Create an int8 (bigserial) primary-key column.
 *
 * Maps to Postgres `bigserial` (8-byte integer with an attached sequence).
 * `appkit db introspect` emits this for live `bigserial`/`int8 + nextval()`
 * primary keys so the round-trip stays drift-free.
 */
export function bigid(): AppKitColumnChain {
  return wrap(pgBigserial({ mode: "number" }).primaryKey(), {
    serverGenerated: true,
    primaryKey: true,
  });
}

/**
 * Create a text column.
 * @returns The wrapped column chain.
 */
export function text(): AppKitColumnChain {
  return wrap(pgText(), { pgKind: "text" });
}

/**
 * Create an integer column.
 * @returns The wrapped column chain.
 */
export function integer(): AppKitColumnChain {
  return wrap(pgInteger(), { pgKind: "integer" });
}

/**
 * Create a bigint column.
 * @returns The wrapped column chain.
 */
export function bigint(): AppKitColumnChain {
  return wrap(pgBigint({ mode: "number" }), { pgKind: "bigint" });
}

/**
 * Create a boolean column.
 * @returns The wrapped column chain.
 */
export function boolean(): AppKitColumnChain {
  return wrap(pgBoolean(), { pgKind: "boolean" });
}

/**
 * Create a timestamp column.
 * @returns The wrapped column chain.
 */
export function timestamp(
  options: { timezone?: boolean; withTimezone?: boolean } = {},
): AppKitColumnChain {
  return wrap(
    pgTimestamp({
      mode: "date",
      withTimezone: options.timezone ?? options.withTimezone ?? false,
    }),
    { pgKind: "timestamp" },
  );
}

/**
 * Create a jsonb column.
 * @returns The wrapped column chain.
 */
export function jsonb(): AppKitColumnChain {
  return wrap(pgJsonb(), { pgKind: "jsonb" });
}

/**
 * Create a uuid column.
 * @returns The wrapped column chain.
 */
export function uuid(): AppKitColumnChain {
  return wrap(pgUuid(), { pgKind: "uuid" });
}

/**
 * Create a varchar column.
 * @param length - The length of the column.
 * @returns The wrapped column chain.
 */
export function varchar(length = 255): AppKitColumnChain {
  return wrap(pgVarchar({ length }), { pgKind: "varchar" });
}

/**
 * Create an enum column.
 * @param name - The name of the enum.
 * @param values - The values of the enum.
 * @returns The wrapped column chain.
 */
export function enumColumn(
  name: string,
  values: readonly string[],
): AppKitColumnChain {
  if (values.length === 0) {
    throw new ValidationError(
      `enum "${name}" must declare at least one value`,
      { context: { enumName: name } },
    );
  }

  const enumType = pgEnum(name, values as [string, ...string[]]);
  return wrap(enumType(), { pgKind: "enum" });
}

/** Drizzle column constructor matching a `ColumnKind`, used by `fk()`. */
function buildFkColumn(kind: ColumnKind): unknown {
  switch (kind) {
    case "text":
      return pgText();
    case "varchar":
      return pgVarchar({ length: 255 });
    case "uuid":
      return pgUuid();
    case "bigint":
    case "bigserial":
      return pgBigint({ mode: "number" });
    case "boolean":
      return pgBoolean();
    case "jsonb":
      return pgJsonb();
    case "timestamp":
      return pgTimestamp({ mode: "date" });
    case "enum":
      // Enums always live in the target table; FK column reuses text storage.
      return pgText();
    default:
      return pgInteger();
  }
}

/**
 * Create a foreign key column. The reference target is captured live and
 * resolved at `buildTable()` time, so forward references (e.g. `fk(other.id)`
 * declared before `table("other", ...)`) work. When the target was already
 * built, `toTable`/`toColumn` are populated immediately so the introspector
 * doesn't depend on define-schema's deferred resolver running first.
 *
 * The FK column type mirrors the target's `pgKind` (e.g. `text`, `uuid`,
 * `bigint`), falling back to `integer` if the target is unstamped.
 *
 * @param target - The target column to reference.
 * @returns A FK column chain. `onDelete`/`onUpdate` return the FK chain so
 * order does not matter; chain methods (`.notNull()`, `.unique()`, etc.) also
 * return the FK chain so `.notNull().onDelete("cascade")` typechecks.
 */
export function fk(target: AppKitColumn): FkColumnChain {
  const kind = target.$meta.pgKind ?? "integer";
  const baseChain = wrap(buildFkColumn(kind), {
    pgKind: kind,
    references: {
      target,
      ...(target.$meta.tableName && target.$meta.columnName
        ? {
            toTable: target.$meta.tableName,
            toColumn: target.$meta.columnName,
          }
        : {}),
    },
  });

  const fkChain = baseChain as FkColumnChain;
  Object.assign(fkChain, {
    onDelete(value: NonNullable<Relation["onDelete"]>) {
      fkChain.$meta.references = {
        ...(fkChain.$meta.references ?? { target }),
        onDelete: value,
      };
      return fkChain;
    },
    onUpdate(value: NonNullable<Relation["onUpdate"]>) {
      fkChain.$meta.references = {
        ...(fkChain.$meta.references ?? { target }),
        onUpdate: value,
      };
      return fkChain;
    },
  });

  return fkChain;
}
