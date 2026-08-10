import { type SQLTypeMarker, sql as sqlHelpers } from "shared";
import {
  isValidColumnName,
  isValidFqn,
  quoteFqnForSql,
  quoteIdentifier,
} from "../../../../../shared/src/schemas/metric-fqn";
import type {
  IAnalyticsMetricRequest,
  MetricFilter,
  MetricFilterOperatorName,
  MetricPredicate,
  MetricRegistration,
} from "../types";
import {
  METRIC_FILTER_MAX_DEPTH,
  METRIC_FILTER_OPERATORS,
  TIME_GRAIN_PATTERN,
} from "./constants";
import type { FilterRenderState } from "./types";

function quoteSafeFqn(fqn: string): string {
  if (!isValidFqn(fqn)) {
    throw new Error(
      `Refusing to build SQL: "${fqn}" is not a valid three-part UC FQN.`,
    );
  }
  return quoteFqnForSql(fqn);
}

export function buildMetricSql(
  registration: MetricRegistration,
  request: IAnalyticsMetricRequest,
): {
  statement: string;
  parameters: Record<string, SQLTypeMarker>;
} {
  const quotedSource = quoteSafeFqn(registration.source);

  if (request.measures.length === 0) {
    throw new Error("buildMetricSql requires at least one measure.");
  }

  for (const m of request.measures) {
    if (!isValidColumnName(m)) {
      throw new Error(
        `Refusing to build SQL: measure "${m}" is not a valid identifier.`,
      );
    }
  }

  const dimensions = request.dimensions ?? [];
  for (const d of dimensions) {
    if (!isValidColumnName(d)) {
      throw new Error(
        `Refusing to build SQL: dimension "${d}" is not a valid identifier.`,
      );
    }
  }

  const measureClauses = [...request.measures]
    .sort()
    .map((m) => `MEASURE(${quoteIdentifier(m)}) AS ${quoteIdentifier(m)}`);

  const sortedDimensions = [...dimensions].sort();
  const dimensionClauses = sortedDimensions.map((d) =>
    renderDimensionClause(d, request.timeGrain, request.timeDimension),
  );

  const selectList = [...measureClauses, ...dimensionClauses].join(", ");
  const groupByClause = dimensions.length > 0 ? " GROUP BY ALL" : "";
  const orderByClause = renderOrderByClause(request, sortedDimensions);

  const limitClause =
    typeof request.limit === "number" && request.limit > 0
      ? ` LIMIT ${Math.floor(request.limit)}`
      : "";

  const parameters: Record<string, SQLTypeMarker> = {};
  let whereClause = "";
  if (request.filter !== undefined) {
    const fragment = renderFilter(request.filter, parameters, {
      counter: 0,
      depth: 0,
    });
    if (fragment !== null && fragment.length > 0) {
      whereClause = ` WHERE ${fragment}`;
    }
  }

  const statement = `SELECT ${selectList} FROM ${quotedSource}${whereClause}${groupByClause}${orderByClause}${limitClause}`;
  return { statement, parameters };
}

function renderFilter(
  node: MetricFilter,
  params: Record<string, SQLTypeMarker>,
  state: FilterRenderState,
): string | null {
  if (node === null || typeof node !== "object") {
    throw new Error(
      "Refusing to build SQL: filter node must be an object Predicate or { and } / { or } group.",
    );
  }

  if ("and" in node || "or" in node) {
    const groupKey = "and" in node ? "and" : "or";
    if (state.depth + 1 > METRIC_FILTER_MAX_DEPTH) {
      throw new Error(
        `Refusing to build SQL: filter AND/OR nesting exceeds the maximum depth of ${METRIC_FILTER_MAX_DEPTH}.`,
      );
    }

    const children = (
      node as { and?: ReadonlyArray<MetricFilter> } & {
        or?: ReadonlyArray<MetricFilter>;
      }
    )[groupKey];

    if (!Array.isArray(children) || children.length === 0) {
      // Empty group → the Boolean identity element for the operator, so the
      // result is correct in ANY position (including nested inside the other
      // operator). An empty OR is vacuously false (`1 = 0`); an empty AND is
      // vacuously true (`1 = 1`). Returning `null` for empty-AND (dropped by the
      // parent) would only be correct at the top level — nested in an OR it
      // would silently vanish and turn `TRUE OR P` into `P`, under-returning
      // rows. (The validator rejects empty groups outright; this is the
      // defense-in-depth fallback and must be semantically correct too.)
      return groupKey === "or" ? "1 = 0" : "1 = 1";
    }

    const sortedChildren = sortFilterChildren(children);

    const fragments: string[] = [];
    const childState: FilterRenderState = {
      counter: state.counter,
      depth: state.depth + 1,
    };
    for (const child of sortedChildren) {
      const rendered = renderFilter(child, params, childState);
      if (rendered != null && rendered.length > 0) {
        fragments.push(rendered);
      }
    }
    state.counter = childState.counter;

    if (fragments.length === 0) return null;
    if (fragments.length === 1) return fragments[0];
    const joiner = groupKey === "and" ? " AND " : " OR ";
    return `(${fragments.join(joiner)})`;
  }

  const predicate = node as MetricPredicate;

  if (!isValidColumnName(predicate.member)) {
    throw new Error(
      `Refusing to build SQL: filter member "${predicate.member}" is not a valid identifier.`,
    );
  }
  if (
    !METRIC_FILTER_OPERATORS.includes(
      predicate.operator as MetricFilterOperatorName,
    )
  ) {
    throw new Error(
      `Refusing to build SQL: unknown filter operator "${predicate.operator}".`,
    );
  }

  return renderPredicate(predicate, params, state);
}

export function sortFilterChildren(
  children: ReadonlyArray<MetricFilter>,
): MetricFilter[] {
  const indexed = children.map((child, idx) => {
    let key: string;
    let isPredicate: boolean;
    if (
      child !== null &&
      typeof child === "object" &&
      !("and" in child) &&
      !("or" in child)
    ) {
      const p = child as MetricPredicate;
      key = JSON.stringify([p.member, p.operator]);
      isPredicate = true;
    } else {
      key = "";
      isPredicate = false;
    }
    return { child, idx, key, isPredicate };
  });

  indexed.sort((a, b) => {
    if (a.isPredicate && !b.isPredicate) return -1;
    if (!a.isPredicate && b.isPredicate) return 1;
    if (a.isPredicate && b.isPredicate) {
      if (a.key < b.key) return -1;
      if (a.key > b.key) return 1;
    }
    return a.idx - b.idx;
  });

  return indexed.map((entry) => entry.child);
}

function renderPredicate(
  predicate: MetricPredicate,
  params: Record<string, SQLTypeMarker>,
  state: FilterRenderState,
): string {
  const col = quoteIdentifier(predicate.member);
  const op = predicate.operator;
  const values = predicate.values ?? [];

  switch (op) {
    case "equals":
      return `${col} = ${bindValue(values[0], params, state)}`;
    case "notEquals":
      return `${col} <> ${bindValue(values[0], params, state)}`;
    case "gt":
      return `${col} > ${bindValue(values[0], params, state)}`;
    case "gte":
      return `${col} >= ${bindValue(values[0], params, state)}`;
    case "lt":
      return `${col} < ${bindValue(values[0], params, state)}`;
    case "lte":
      return `${col} <= ${bindValue(values[0], params, state)}`;
    case "in": {
      const placeholders = values.map((v) => bindValue(v, params, state));
      return `${col} IN (${placeholders.join(", ")})`;
    }
    case "notIn": {
      const placeholders = values.map((v) => bindValue(v, params, state));
      return `${col} NOT IN (${placeholders.join(", ")})`;
    }
    case "contains": {
      const raw = values[0];
      if (typeof raw !== "string") {
        throw new Error(
          `Refusing to build SQL: filter operator "contains" requires a string value (got ${typeof raw}).`,
        );
      }
      return `${col} LIKE ${bindLikeValue(raw, params, state)}`;
    }
    case "notContains": {
      const raw = values[0];
      if (typeof raw !== "string") {
        throw new Error(
          `Refusing to build SQL: filter operator "notContains" requires a string value (got ${typeof raw}).`,
        );
      }
      return `${col} NOT LIKE ${bindLikeValue(raw, params, state)}`;
    }
    case "set":
      return `${col} IS NOT NULL`;
    case "notSet":
      return `${col} IS NULL`;
    default: {
      const _exhaustive: never = op;
      throw new Error(
        `Refusing to build SQL: unhandled filter operator "${_exhaustive as string}".`,
      );
    }
  }
}

function bindValue(
  value: string | number | undefined,
  params: Record<string, SQLTypeMarker>,
  state: FilterRenderState,
): string {
  if (value === undefined) {
    throw new Error(
      "Refusing to build SQL: filter predicate is missing a required value.",
    );
  }
  const name = `f_${state.counter}`;
  state.counter += 1;
  if (typeof value === "number") {
    params[name] = sqlHelpers.number(value);
  } else if (typeof value === "string") {
    params[name] = sqlHelpers.string(value);
  } else {
    throw new Error(
      `Refusing to build SQL: filter value must be a string or number (got ${typeof value}).`,
    );
  }
  return `:${name}`;
}

function bindLikeValue(
  value: string,
  params: Record<string, SQLTypeMarker>,
  state: FilterRenderState,
): string {
  const name = `f_${state.counter}`;
  state.counter += 1;
  params[name] = sqlHelpers.string(`%${value}%`);
  return `:${name}`;
}

function renderDimensionClause(
  dim: string,
  timeGrain: string | undefined,
  timeDimension: string | undefined,
): string {
  if (timeGrain != null && dim === timeDimension) {
    if (!isValidColumnName(dim)) {
      throw new Error(
        `Refusing to build SQL: timeDimension "${dim}" is not a valid identifier.`,
      );
    }
    if (!TIME_GRAIN_PATTERN.test(timeGrain)) {
      throw new Error(
        `Refusing to build SQL: timeGrain "${timeGrain}" is not a valid grain token.`,
      );
    }
    const quoted = quoteIdentifier(dim);
    return `date_trunc('${timeGrain}', ${quoted}) AS ${quoted}`;
  }
  return quoteIdentifier(dim);
}

function renderOrderByClause(
  request: IAnalyticsMetricRequest,
  sortedDimensions: string[],
): string {
  const keyList: string[] = [];

  if (request.orderBy != null && request.orderBy.length > 0) {
    for (const entry of request.orderBy) {
      if (!isValidColumnName(entry.field)) {
        throw new Error(
          `Refusing to build SQL: orderBy field "${entry.field}" is not a valid identifier.`,
        );
      }
      const direction = entry.direction === "DESC" ? " DESC" : "";
      keyList.push(`${quoteIdentifier(entry.field)}${direction}`);
    }
  }

  // Tie-breaker completion: when limit is set, append all dimensions not
  // already named in orderBy. Under GROUP BY ALL the full dimension tuple is
  // unique per row, so ordering by all dimensions gives a TOTAL order. A
  // partial ordering still leaves ties, and ties + LIMIT = non-determinism.
  if (typeof request.limit === "number" && request.limit > 0) {
    const orderByFields = new Set(request.orderBy?.map((e) => e.field) ?? []);
    for (const dim of sortedDimensions) {
      if (!orderByFields.has(dim)) {
        keyList.push(quoteIdentifier(dim));
      }
    }
  }

  // Return empty string when there is nothing to order by. This covers:
  // no orderBy + no limit; and no orderBy + limit but zero dimensions
  // (a pure aggregate returns exactly one row, ordering is pointless).
  if (keyList.length === 0) {
    return "";
  }

  return ` ORDER BY ${keyList.join(", ")}`;
}
