import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { IN_CAP, MAX_INCLUDES } from "../../contract";
import type { AppKitTable } from "../../schema-builder";
import {
  clampLimit,
  DataPathError,
  type FilterOps,
  type IncludeOptions,
  type IncludeSpec,
  isRelationPredicate,
  type OrderSpec,
  type RelationPredicate,
  type WhereClause,
} from "../data-path";
import { defaultColumns } from "../projection";
import { colOf } from "./column";

type Schema = Record<string, AppKitTable>;

/** A filter operator -> a Drizzle condition fragment. */
const OPS: Record<string, (c: AnyPgColumn, v: unknown) => SQL> = {
  eq: (c, v) => (v === null ? isNull(c) : eq(c, v)),
  neq: (c, v) => (v === null ? isNotNull(c) : ne(c, v)),
  gt: (c, v) => gt(c, v),
  gte: (c, v) => gte(c, v),
  lt: (c, v) => lt(c, v),
  lte: (c, v) => lte(c, v),
  like: (c, v) => like(c, String(v)),
  ilike: (c, v) => ilike(c, String(v)),
  in: (c, v) => inList(c, v),
  is: (c, v) => (v === null || v === "null" ? isNull(c) : isNotNull(c)),
};

function inList(c: AnyPgColumn, v: unknown): SQL {
  const arr = Array.isArray(v) ? v : [v];
  if (arr.length > IN_CAP) {
    throw new DataPathError(`in.(…) list exceeds IN_CAP (${IN_CAP})`);
  }
  return inArray(c, arr);
}

function tableByName(schema: Schema, name: string): AppKitTable | undefined {
  return schema[name] ?? Object.values(schema).find((t) => t.$name === name);
}

/** Agnostic where clause translation. */
export function translateWhere(
  table: AppKitTable,
  schema: Schema,
  clause: WhereClause,
): SQL | undefined {
  const conds: SQL[] = [];
  for (const [key, value] of Object.entries(clause)) {
    if (key === "and" || key === "or") {
      const groups = (value as WhereClause[])
        .map((g) => translateWhere(table, schema, g))
        .filter((s): s is SQL => Boolean(s));
      if (groups.length > 0) {
        const combined = key === "and" ? and(...groups) : or(...groups);
        if (combined) conds.push(combined);
      }
      continue;
    }

    if (isRelationPredicate(value)) {
      conds.push(translateRelationPredicate(table, schema, key, value));
      continue;
    }

    const col = colOf(table, key);
    if (Array.isArray(value)) {
      conds.push(inList(col, value));
    } else if (value !== null && typeof value === "object") {
      for (const [op, opVal] of Object.entries(value as FilterOps)) {
        const fn = OPS[op];
        if (!fn) throw new DataPathError(`Unknown filter operator: ${op}`);
        conds.push(fn(col, opVal));
      }
    } else {
      conds.push(value === null ? isNull(col) : eq(col, value));
    }
  }
  return conds.length > 0 ? and(...conds) : undefined;
}

/** `{ some|none }` → correlated `EXISTS` / `NOT EXISTS` (no row multiplication). */
function translateRelationPredicate(
  table: AppKitTable,
  schema: Schema,
  relationName: string,
  predicate: RelationPredicate,
): SQL {
  const relation = table.$relations.find((r) => r.name === relationName);
  if (!relation) throw new DataPathError(`Unknown relation: ${relationName}`);
  const child = tableByName(schema, relation.targetTable);
  if (!child)
    throw new DataPathError(`Unknown child table: ${relation.targetTable}`);
  const parentCol = colOf(table, relation.localColumn);
  const childCol = colOf(child, relation.targetColumn);
  const inner = predicate.some ?? predicate.none;
  const innerSql = inner ? translateWhere(child, schema, inner) : undefined;
  const correlation = sql`${childCol} = ${parentCol}`;
  const whereSql = innerSql ? and(correlation, innerSql) : correlation;
  const subquery = sql`select 1 from ${child.$engine as unknown as PgTable} where ${whereSql}`;
  return predicate.none
    ? sql`not exists (${subquery})`
    : sql`exists (${subquery})`;
}

/** Our `OrderSpec` → Drizzle `orderBy` array. */
export function translateOrder(table: AppKitTable, order: OrderSpec): SQL[] {
  return Object.entries(order).map(([col, direction]) =>
    direction === "desc" ? desc(colOf(table, col)) : asc(colOf(table, col)),
  );
}

/** A `select` list → Drizzle relational `columns` (include mode; validates each column). */
export function selectToColumns(
  table: AppKitTable,
  select: string[],
): Record<string, true> {
  const columns: Record<string, true> = {};
  for (const col of select) {
    colOf(table, col);
    columns[col] = true;
  }

  return columns;
}

/** Our `IncludeSpec` → Drizzle relational `with` config (recursive per-relation options). */
export function translateInclude(
  table: AppKitTable,
  schema: Schema,
  include: IncludeSpec,
): Record<string, unknown> {
  const keys = Object.keys(include);
  if (keys.length > MAX_INCLUDES) {
    throw new DataPathError(`include exceeds MAX_INCLUDES (${MAX_INCLUDES})`);
  }
  const withConfig: Record<string, unknown> = {};
  for (const [relName, opt] of Object.entries(include)) {
    if (opt === false) continue;
    const rel = table.$relations.find((r) => r.name === relName);
    if (!rel)
      throw new DataPathError(`Unknown relation "${table.$name}.${relName}"`);
    const child = tableByName(schema, rel.targetTable);
    if (!child)
      throw new DataPathError(`Unknown child table: ${rel.targetTable}`);
    if (opt === true) {
      withConfig[relName] = { columns: defaultColumns(child) };
      continue;
    }
    const o = opt as IncludeOptions;
    const cfg: Record<string, unknown> = {};
    cfg.columns = o.select
      ? selectToColumns(child, o.select)
      : defaultColumns(child);
    if (o.where) cfg.where = translateWhere(child, schema, o.where);
    if (o.order) cfg.orderBy = translateOrder(child, o.order);
    if (o.limit !== undefined) cfg.limit = clampLimit(o.limit);
    withConfig[relName] = cfg;
  }
  return withConfig;
}
