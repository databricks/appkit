import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  like,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  DEFAULT_LIMIT,
  type FilterOperator,
  IN_CAP,
  isFilterOperator,
  MAX_INCLUDES,
} from "../../contract";
import type { AppKitTable, ColumnMeta, Schema } from "../../schema-builder";
import { filterOperatorsForKind } from "../../schema-builder/types";
import { columnValueSchema } from "../../schema-builder/validators";
import {
  DataPathError,
  type FilterOps,
  type IncludeOptions,
  type IncludeSpec,
  type OrderSpec,
  validateLimit,
  type WhereClause,
} from "../data-path";

function columnMetaOf(table: AppKitTable, key: string): ColumnMeta {
  const column = table.$columns[key];
  if (!column) {
    throw new DataPathError(`Unknown column "${table.$name}.${key}"`);
  }
  return column;
}

/** Resolve SQL identifiers only through columns finalized by the schema builder. */
export function columnOf(table: AppKitTable, key: string): AnyPgColumn {
  return columnMetaOf(table, key).engineColumn as unknown as AnyPgColumn;
}

/** Default reads select all finalized columns except private application data. */
export function defaultColumns(table: AppKitTable): Record<string, true> {
  const columns: Record<string, true> = {};
  for (const column of Object.values(table.$columns)) {
    if (!column.isPrivate) columns[column.columnName] = true;
  }
  return columns;
}

function supportsOperator(meta: ColumnMeta, operator: FilterOperator): boolean {
  if (operator === "is") {
    return !meta.notNull && meta.kind !== "json" && meta.kind !== "unknown";
  }
  return filterOperatorsForKind(meta.kind).includes(operator);
}

function assertColumnValue(
  table: AppKitTable,
  meta: ColumnMeta,
  operator: FilterOperator,
  value: unknown,
): void {
  if (!columnValueSchema(meta).safeParse(value).success) {
    throw new DataPathError(
      `Invalid ${operator} operand for "${table.$name}.${meta.columnName}"`,
    );
  }
}

function inList(
  table: AppKitTable,
  meta: ColumnMeta,
  column: AnyPgColumn,
  value: unknown,
): SQL {
  if (!Array.isArray(value)) {
    throw new DataPathError('The "in" operator requires an array');
  }
  if (value.length > IN_CAP) {
    throw new DataPathError(`in list exceeds the ${IN_CAP}-value limit`);
  }
  for (const item of value) {
    if (item === null) {
      throw new DataPathError('The "in" operator does not accept null');
    }
    assertColumnValue(table, meta, "in", item);
  }
  return value.length === 0 ? sql.raw("false") : inArray(column, value);
}

function translateOperator(
  table: AppKitTable,
  meta: ColumnMeta,
  column: AnyPgColumn,
  operator: FilterOperator,
  value: unknown,
): SQL {
  if (!supportsOperator(meta, operator)) {
    throw new DataPathError(
      `Operator "${operator}" is not supported for "${table.$name}.${meta.columnName}"`,
    );
  }
  if (operator === "is") {
    if (value !== null) {
      throw new DataPathError('The "is" operator accepts only null');
    }
    return isNull(column);
  }
  if (operator === "in") return inList(table, meta, column, value);

  assertColumnValue(table, meta, operator, value);
  switch (operator) {
    case "eq":
      return eq(column, value);
    case "neq":
      return ne(column, value);
    case "gt":
      return gt(column, value);
    case "gte":
      return gte(column, value);
    case "lt":
      return lt(column, value);
    case "lte":
      return lte(column, value);
    case "like":
      return like(column, value as string);
    case "ilike":
      return ilike(column, value as string);
    default:
      throw new DataPathError(`Unsupported filter operator "${operator}"`);
  }
}

/** Translate direct-column predicates. Relation predicates are not supported. */
export function translateWhere(
  table: AppKitTable,
  clause: WhereClause,
): SQL | undefined {
  if (clause === null || typeof clause !== "object" || Array.isArray(clause)) {
    throw new DataPathError("where must be an object");
  }
  const conditions: SQL[] = [];
  for (const [key, value] of Object.entries(clause)) {
    if (key === "and" || key === "or") {
      if (!Array.isArray(value) || value.length === 0) {
        throw new DataPathError(`${key} requires a non-empty predicate array`);
      }
      const groups = value.map((group) => {
        const translated = translateWhere(table, group as WhereClause);
        if (!translated) {
          throw new DataPathError(`${key} predicates cannot be empty`);
        }
        return translated;
      });
      const combined = key === "and" ? and(...groups) : or(...groups);
      if (combined) {
        conditions.push(combined);
      }
      continue;
    }

    const meta = columnMetaOf(table, key);
    const column = meta.engineColumn as unknown as AnyPgColumn;
    if (Array.isArray(value)) {
      conditions.push(translateOperator(table, meta, column, "in", value));
    } else if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const operators = Object.entries(value as FilterOps);
      if (operators.length === 0) {
        throw new DataPathError(
          `Filter for "${table.$name}.${key}" cannot be empty`,
        );
      }
      for (const [operator, operand] of operators) {
        if (!isFilterOperator(operator)) {
          throw new DataPathError(`Unknown filter operator "${operator}"`);
        }
        conditions.push(
          translateOperator(table, meta, column, operator, operand),
        );
      }
    } else {
      conditions.push(translateOperator(table, meta, column, "eq", value));
    }
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export function translateOrder(table: AppKitTable, order: OrderSpec): SQL[] {
  return Object.entries(order).map(([key, direction]) => {
    if (direction !== "asc" && direction !== "desc") {
      throw new DataPathError(`Unknown order direction "${direction}"`);
    }
    const column = columnOf(table, key);
    return direction === "desc" ? desc(column) : asc(column);
  });
}

export function selectToColumns(
  table: AppKitTable,
  select: readonly string[],
): Record<string, true> {
  const columns: Record<string, true> = {};
  for (const key of select) {
    columnOf(table, key);
    columns[key] = true;
  }
  return columns;
}

function tableByName(schema: Schema, name: string): AppKitTable {
  const table = schema.$tables[name];
  if (!table) throw new DataPathError(`Unknown table "${name}"`);
  return table;
}

/** Translate one relation edge into Drizzle's relational `with` config. */
export function translateInclude(
  table: AppKitTable,
  schema: Schema,
  include: IncludeSpec,
): Record<string, unknown> {
  const entries = Object.entries(include);
  if (entries.length > MAX_INCLUDES) {
    throw new DataPathError(
      `include exceeds the ${MAX_INCLUDES}-relation limit`,
    );
  }

  const config: Record<string, unknown> = {};
  for (const [relationName, rawOptions] of entries) {
    const relation = table.$relations.find(
      (candidate) => candidate.name === relationName,
    );
    if (!relation) {
      throw new DataPathError(
        `Unknown relation "${table.$name}.${relationName}"`,
      );
    }
    if (rawOptions === false) continue;

    const target = tableByName(schema, relation.targetTable);
    if (rawOptions === true) {
      config[relationName] = {
        columns: defaultColumns(target),
        ...(relation.cardinality === "toMany" ? { limit: DEFAULT_LIMIT } : {}),
      };
      continue;
    }

    const options = rawOptions as IncludeOptions;
    const relationConfig: Record<string, unknown> = {
      columns:
        options.select === undefined
          ? defaultColumns(target)
          : selectToColumns(target, options.select),
    };
    if (options.where !== undefined) {
      relationConfig.where = translateWhere(target, options.where);
    }
    if (options.order !== undefined) {
      relationConfig.orderBy = translateOrder(target, options.order);
    }
    if (options.limit !== undefined) {
      if (relation.cardinality !== "toMany") {
        throw new DataPathError("Only to-many relations accept a limit");
      }
      relationConfig.limit = validateLimit(options.limit);
    } else if (relation.cardinality === "toMany") {
      relationConfig.limit = DEFAULT_LIMIT;
    }
    config[relationName] = relationConfig;
  }
  return config;
}
