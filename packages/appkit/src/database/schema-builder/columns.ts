import {
  bigint as pgBigint,
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
 * Create a primary key column with a serial type.
 * @returns The wrapped column chain.
 */
export function id(): AppKitColumnChain {
  return wrap(serial().primaryKey(), {
    serverGenerated: true,
  });
}

/**
 * Create a text column.
 * @returns The wrapped column chain.
 */
export function text(): AppKitColumnChain {
  return wrap(pgText());
}

/**
 * Create an integer column.
 * @returns The wrapped column chain.
 */
export function integer(): AppKitColumnChain {
  return wrap(pgInteger());
}

/**
 * Create a bigint column.
 * @returns The wrapped column chain.
 */
export function bigint(): AppKitColumnChain {
  return wrap(pgBigint({ mode: "number" }));
}

/**
 * Create a boolean column.
 * @returns The wrapped column chain.
 */
export function boolean(): AppKitColumnChain {
  return wrap(pgBoolean());
}

/**
 * Create a timestamp column.
 * @returns The wrapped column chain.
 */
export function timestamp(): AppKitColumnChain {
  return wrap(pgTimestamp({ mode: "date" }));
}

/**
 * Create a jsonb column.
 * @returns The wrapped column chain.
 */
export function jsonb(): AppKitColumnChain {
  return wrap(pgJsonb());
}

/**
 * Create a uuid column.
 * @returns The wrapped column chain.
 */
export function uuid(): AppKitColumnChain {
  return wrap(pgUuid());
}

/**
 * Create a varchar column.
 * @param length - The length of the column.
 * @returns The wrapped column chain.
 */
export function varchar(length = 255): AppKitColumnChain {
  return wrap(pgVarchar({ length }));
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
    throw new ValidationError(`enumColumn ${name} values must not be empty`, {
      context: { enumName: name },
    });
  }

  const enumType = pgEnum(name, values as [string, ...string[]]);
  return wrap(enumType());
}

/**
 * Create a foreign key column. The reference target is captured live and
 * resolved at `buildTable()` time, so forward references (e.g. `fk(other.id)`
 * declared before `table("other", ...)`) work.
 *
 * The FK column type is currently fixed to `integer`. If the target is a
 * `bigid()` (`bigserial`) or `uuid()` PK, declare the FK column with the
 * matching type explicitly until per-target type inference is added.
 *
 * @param target - The target column to reference.
 * @returns A FK column chain. `onDelete`/`onUpdate` return the FK chain so
 * order does not matter; chain methods (`.notNull()`, `.unique()`, etc.) also
 * return the FK chain so `.notNull().onDelete("cascade")` typechecks.
 */
export function fk(target: AppKitColumn): FkColumnChain {
  const baseChain = wrap(pgInteger(), {
    // Live target reference; buildTable() resolves to toTable/toColumn after
    // all tables have been built and column names stamped.
    references: { target },
  });

  // Override chain methods to return FkColumnChain at the type level. Runtime
  // returns the same chain object so the cast is safe.
  const fkChain: FkColumnChain = Object.assign(baseChain, {
    notNull: () => {
      baseChain.notNull();
      return fkChain;
    },
    unique: () => {
      baseChain.unique();
      return fkChain;
    },
    primaryKey: () => {
      baseChain.primaryKey();
      return fkChain;
    },
    default<T>(value: T) {
      baseChain.default(value);
      return fkChain;
    },
    defaultNow: () => {
      baseChain.defaultNow();
      return fkChain;
    },
    defaultRandom: () => {
      baseChain.defaultRandom();
      return fkChain;
    },
    private: () => {
      baseChain.private();
      return fkChain;
    },
    onDelete: (value: NonNullable<Relation["onDelete"]>) => {
      fkChain.$meta.references = {
        ...(fkChain.$meta.references ?? {}),
        onDelete: value,
      };
      return fkChain;
    },
    onUpdate: (value: NonNullable<Relation["onUpdate"]>) => {
      fkChain.$meta.references = {
        ...(fkChain.$meta.references ?? {}),
        onUpdate: value,
      };
      return fkChain;
    },
  }) as FkColumnChain;

  return fkChain;
}
