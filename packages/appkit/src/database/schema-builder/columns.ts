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
 * Create a foreign key column.
 * @param target - The target column to reference.
 * @returns The wrapped column chain.
 */
export function fk(target: AppKitColumn): AppKitColumnChain & {
  onDelete(value: NonNullable<Relation["onDelete"]>): AppKitColumnChain;
  onUpdate(value: NonNullable<Relation["onUpdate"]>): AppKitColumnChain;
} {
  const chain = wrap(pgInteger(), {
    references:
      target.$meta.tableName && target.$meta.columnName
        ? {
            toTable: target.$meta.tableName,
            toColumn: target.$meta.columnName,
          }
        : undefined,
  }) as AppKitColumnChain & {
    onDelete(value: NonNullable<Relation["onDelete"]>): AppKitColumnChain;
    onUpdate(value: NonNullable<Relation["onUpdate"]>): AppKitColumnChain;
  };
  chain.onDelete = (value) => {
    chain.$meta.references = {
      ...(chain.$meta.references ?? { toTable: "", toColumn: "" }),
      onDelete: value,
    };
    return chain;
  };
  chain.onUpdate = (value) => {
    chain.$meta.references = {
      ...(chain.$meta.references ?? { toTable: "", toColumn: "" }),
      onUpdate: value,
    };
    return chain;
  };
  return chain;
}
