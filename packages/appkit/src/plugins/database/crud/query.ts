import {
  DEFAULT_LIMIT,
  IN_CAP,
  isFilterOperator,
  MAX_INCLUDE_DEPTH,
  MAX_INCLUDE_NODES,
  MAX_INCLUDES,
  MAX_LIMIT,
} from "../../../database/contract";
import { invalidDatabaseInput } from "../../../database/errors";
import type {
  IncludeOptions,
  IncludeSpec,
  OrderDirection,
  OrderSpec,
  ScalarValue,
  WhereClause,
  WhereValue,
} from "../../../database/runtime";
import { filterOperatorsForKind } from "../../../database/schema-builder/types";
import {
  MAX_GROUP_ITEMS,
  MAX_MATERIALIZED_NODES,
  MAX_OFFSET,
  MAX_ORDER_FIELDS,
  MAX_QUERY_BYTES,
  MAX_WHERE_CONDITIONS,
  MAX_WHERE_DEPTH,
} from "../defaults";
import type { CompiledColumn } from "./codecs";
import type { CrudTable } from "./contract";

/** One decoded, budget-checked page request. */
interface DecodedListQuery {
  readonly where?: WhereClause;
  readonly order?: OrderSpec;
  readonly select?: string[];
  readonly include?: IncludeSpec;
  readonly limit: number;
  readonly offset: number;
}

/** One decoded, budget-checked single-row request. */
interface DecodedDetailQuery {
  readonly select?: string[];
  readonly include?: IncludeSpec;
}

const LIST_PARAMS = new Set([
  "where",
  "order",
  "select",
  "include",
  "limit",
  "offset",
]);
const DETAIL_PARAMS = new Set(["select", "include"]);
const CANONICAL_INT = /^-?(0|[1-9]\d*)$/;

/**
 * Reject one query parameter. `parameter` is always a fixed name and `reason`
 * a fixed sentence, so a rejection can never echo caller-supplied text back.
 */
function reject(parameter: string, reason: string): never {
  throw invalidDatabaseInput([parameter], reason);
}

/** A decoded JSON object; arrays and null are separate wire shapes here. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read known, single-occurrence parameters from the raw query string. */
function parseParams(
  rawQuery: string,
  allowed: ReadonlySet<string>,
): Map<string, string> {
  if (Buffer.byteLength(rawQuery, "utf8") > MAX_QUERY_BYTES) {
    reject("query", "Query string exceeds the maximum size");
  }
  const params = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(rawQuery)) {
    if (!allowed.has(key) || params.has(key)) {
      reject("query", "Unknown or repeated query parameter");
    }
    params.set(key, value);
  }
  return params;
}

/** Parse one structured parameter without leaking the parser's diagnostics. */
function parseJson(raw: string, parameter: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    reject(parameter, "Expected JSON");
  }
}

/** Accept one bounded integer, rejecting the forms `Number` would coerce. */
function decodeIntParam(
  raw: string | undefined,
  parameter: string,
  fallback: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  if (!CANONICAL_INT.test(raw)) {
    reject(parameter, "Expected a canonical decimal integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    reject(parameter, `Must be between 0 and ${max}`);
  }
  return value;
}

/** Narrow a projection to the table's public columns. */
function decodeSelect(
  table: CrudTable,
  value: unknown,
  parameter: string,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    reject(parameter, "Expected a non-empty array of public column names");
  }
  for (const name of value) {
    if (typeof name !== "string" || !table.selectable.has(name)) {
      reject(parameter, "Names an unknown or private column");
    }
  }
  return value as string[];
}

/** Order only by columns the table can sort on, in a declared direction. */
function decodeOrder(
  table: CrudTable,
  value: unknown,
  parameter: string,
): OrderSpec {
  if (!isPlainObject(value)) {
    reject(parameter, "Expected an object of column directions");
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_ORDER_FIELDS) {
    reject(parameter, `Expected 1 to ${MAX_ORDER_FIELDS} columns`);
  }
  const order: Record<string, OrderDirection> = {};
  for (const [column, direction] of entries) {
    if (!table.queryable.has(column)) {
      reject(parameter, "Names an unknown or unorderable column");
    }
    if (direction !== "asc" && direction !== "desc") {
      reject(parameter, "Expected a direction of asc or desc");
    }
    order[column] = direction;
  }
  return order;
}

/** Move one filter operand onto its column's canonical runtime value. */
function decodeOperand(
  column: CompiledColumn,
  raw: unknown,
  parameter: string,
): ScalarValue {
  const value = column.decode(raw);
  if (value === undefined)
    reject(parameter, "Operand does not match its column type");
  return value;
}

/**
 * Decode the predicate on one column against the operator matrix its kind
 * allows, counting conditions so a filter cannot grow without bound.
 */
function decodeCondition(
  column: CompiledColumn,
  value: unknown,
  parameter: string,
  state: { conditions: number },
): WhereValue {
  const countCondition = () => {
    state.conditions += 1;
    if (state.conditions > MAX_WHERE_CONDITIONS) {
      reject(parameter, `Expected at most ${MAX_WHERE_CONDITIONS} conditions`);
    }
  };

  if (value === null) {
    // SQL three-valued matching stays explicit; a bare null is ambiguous.
    reject(parameter, "Match a null column with is: null");
  }
  if (!isPlainObject(value)) {
    if (Array.isArray(value)) {
      reject(parameter, "Expected a scalar or an operator object");
    }
    countCondition();
    return decodeOperand(column, value, parameter);
  }

  const nullable = !column.meta.notNull;
  const supported = filterOperatorsForKind(column.meta.kind);
  const operators: Record<string, ScalarValue | ScalarValue[]> = {};
  const entries = Object.entries(value);
  if (entries.length === 0) reject(parameter, "Filter cannot be empty");

  for (const [operator, operand] of entries) {
    countCondition();
    if (operator === "is") {
      if (operand !== null || !nullable) {
        reject(
          parameter,
          "The is operator accepts only null on a nullable column",
        );
      }
      operators.is = null;
      continue;
    }
    if (!isFilterOperator(operator) || !supported.includes(operator)) {
      reject(parameter, "Operator is not supported for this column");
    }
    if (operator !== "in") {
      operators[operator] = decodeOperand(column, operand, parameter);
      continue;
    }
    if (!Array.isArray(operand) || operand.length > IN_CAP) {
      reject(parameter, `Expected an array of at most ${IN_CAP} values`);
    }
    operators.in = operand.map((item) => {
      if (item === null)
        reject(parameter, "The in operator does not accept null");
      return decodeOperand(column, item, parameter);
    });
  }
  return operators as WhereValue;
}

/** Decode one filter level, recursing through bounded `and`/`or` groups. */
function decodeWhere(
  table: CrudTable,
  node: unknown,
  depth: number,
  parameter: string,
  state: { conditions: number },
): WhereClause {
  if (depth > MAX_WHERE_DEPTH) {
    reject(parameter, `Expected at most ${MAX_WHERE_DEPTH} nesting levels`);
  }
  if (!isPlainObject(node)) reject(parameter, "Expected an object");

  const clause: Record<string, WhereValue | WhereClause[]> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "and" || key === "or") {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.length > MAX_GROUP_ITEMS
      ) {
        reject(parameter, `Expected 1 to ${MAX_GROUP_ITEMS} group members`);
      }
      clause[key] = value.map((member) =>
        decodeWhere(table, member, depth + 1, parameter, state),
      );
      continue;
    }
    // Relations are absent from `queryable`, so relation predicates fail here.
    const column = table.queryable.has(key)
      ? table.columns.get(key)
      : undefined;
    if (!column) reject(parameter, "Names an unknown or unfilterable column");
    clause[key] = decodeCondition(column, value, parameter, state);
  }
  return clause;
}

/**
 * Decode one relation's options against the target table, not the parent, and
 * give every to-many edge a limit so an unqualified include stays bounded.
 */
function decodeIncludeOptions(
  target: CrudTable,
  value: unknown,
  depth: number,
  toMany: boolean,
  parameter: string,
): boolean | IncludeOptions {
  if (value === true) return toMany ? { limit: DEFAULT_LIMIT } : true;
  if (!isPlainObject(value)) {
    reject(parameter, "Expected true or an options object");
  }

  const options: {
    select?: string[];
    where?: WhereClause;
    order?: OrderSpec;
    limit?: number;
    include?: IncludeSpec;
  } = {};
  for (const [key, inner] of Object.entries(value)) {
    switch (key) {
      case "select":
        options.select = decodeSelect(target, inner, parameter);
        break;
      case "where":
        options.where = decodeWhere(target, inner, 1, parameter, {
          conditions: 0,
        });
        break;
      case "order":
        options.order = decodeOrder(target, inner, parameter);
        break;
      case "limit":
        if (!toMany) reject(parameter, "Only to-many relations accept a limit");
        if (
          typeof inner !== "number" ||
          !Number.isSafeInteger(inner) ||
          inner < 0 ||
          inner > MAX_LIMIT
        ) {
          reject(parameter, `Expected a limit between 0 and ${MAX_LIMIT}`);
        }
        options.limit = inner;
        break;
      case "include":
        options.include = decodeInclude(target, inner, depth + 1, parameter);
        break;
      default:
        reject(parameter, "Unsupported relation option");
    }
  }
  if (toMany && options.limit === undefined) options.limit = DEFAULT_LIMIT;
  return options;
}

/** Decode one include level; a relation to an unexposed table has no edge. */
function decodeInclude(
  table: CrudTable,
  value: unknown,
  depth: number,
  parameter: string,
): IncludeSpec {
  if (depth > MAX_INCLUDE_DEPTH) {
    reject(parameter, `Expected at most ${MAX_INCLUDE_DEPTH} relation edges`);
  }
  if (!isPlainObject(value)) {
    reject(parameter, "Expected an object of relation names");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_INCLUDES) {
    reject(parameter, `Expected at most ${MAX_INCLUDES} relations per level`);
  }

  const include: Record<string, boolean | IncludeOptions> = {};
  for (const [name, options] of entries) {
    const relation = table.relations.get(name);
    if (!relation) reject(parameter, "Names an unknown or unexposed relation");
    include[name] = decodeIncludeOptions(
      relation.target,
      options,
      depth,
      relation.cardinality === "toMany",
      parameter,
    );
  }
  return include;
}

/**
 * Rows one include tree materializes per parent row, counting relation nodes
 * on the way. Every term is a non-negative integer bounded by `MAX_LIMIT` and
 * both running totals are checked after each addition, so neither can overflow.
 */
function measureInclude(
  table: CrudTable,
  include: IncludeSpec | undefined,
  budget: { nodes: number },
): number {
  let rows = 1;
  if (!include) return rows;
  for (const [name, value] of Object.entries(include)) {
    const relation = table.relations.get(name);
    if (!relation) continue;
    budget.nodes += 1;
    if (budget.nodes > MAX_INCLUDE_NODES) {
      reject("include", `Expected at most ${MAX_INCLUDE_NODES} relations`);
    }
    const options = value === true ? undefined : (value as IncludeOptions);
    const child = measureInclude(relation.target, options?.include, budget);
    rows +=
      relation.cardinality === "toMany"
        ? (options?.limit ?? DEFAULT_LIMIT) * child
        : child;
    if (rows > MAX_MATERIALIZED_NODES) {
      reject("include", "Relation fan-out exceeds the read budget");
    }
  }
  return rows;
}

/** Reject an include tree whose cost is only visible once it is assembled. */
function assertReadBudget(
  table: CrudTable,
  include: IncludeSpec | undefined,
  rootRows: number,
): void {
  const rows = measureInclude(table, include, { nodes: 0 });
  if (rootRows * rows > MAX_MATERIALIZED_NODES) {
    reject("include", "Relation fan-out exceeds the read budget");
  }
}

/** Decode the projection parameters both reads share. */
function decodeProjection(
  table: CrudTable,
  params: ReadonlyMap<string, string>,
): DecodedDetailQuery {
  const rawSelect = params.get("select");
  const rawInclude = params.get("include");
  return {
    select:
      rawSelect === undefined
        ? undefined
        : decodeSelect(table, parseJson(rawSelect, "select"), "select"),
    include:
      rawInclude === undefined
        ? undefined
        : decodeInclude(table, parseJson(rawInclude, "include"), 1, "include"),
  };
}

/** Decode `GET /:table` and reject it before any database work is scheduled. */
export function decodeListQuery(
  table: CrudTable,
  rawQuery: string,
): DecodedListQuery {
  const params = parseParams(rawQuery, LIST_PARAMS);
  const rawWhere = params.get("where");
  const rawOrder = params.get("order");

  const where =
    rawWhere === undefined
      ? undefined
      : decodeWhere(table, parseJson(rawWhere, "where"), 1, "where", {
          conditions: 0,
        });
  const order =
    rawOrder === undefined
      ? undefined
      : decodeOrder(table, parseJson(rawOrder, "order"), "order");
  const { select, include } = decodeProjection(table, params);
  const limit = decodeIntParam(
    params.get("limit"),
    "limit",
    DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  const offset = decodeIntParam(params.get("offset"), "offset", 0, MAX_OFFSET);

  assertReadBudget(table, include, limit);
  return { where, order, select, include, limit, offset };
}

/** Decode `GET /:table/:id`, which supports projection and includes only. */
export function decodeDetailQuery(
  table: CrudTable,
  rawQuery: string,
): DecodedDetailQuery {
  const decoded = decodeProjection(table, parseParams(rawQuery, DETAIL_PARAMS));
  assertReadBudget(table, decoded.include, 1);
  return decoded;
}
