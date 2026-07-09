import fs from "node:fs";
import path from "node:path";
import { type SQLTypeMarker, sql as sqlHelpers } from "shared";
import { z } from "zod";
// Canonical metric-source schema — the single source of truth for
// `metric-views.json`. Imported from the shared source directly (matching the
// type-generator's runtime, which pulls the zod-free `metric-fqn.ts` from the
// same tree) so the runtime and the generated JSON schema validate identically.
import { metricSourceSchema } from "../../../../shared/src/schemas/metric-source";
import { ValidationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type {
  IAnalyticsMetricRequest,
  MetricFilter,
  MetricFilterOperatorName,
  MetricLane,
  MetricPredicate,
  MetricRegistration,
} from "./types";

const logger = createLogger("analytics:metric");

/**
 * Default queries directory. Mirrors `AppManager`'s
 * `path.resolve(process.cwd(), "config/queries")` so dev mode and production
 * share a single source of truth for where metric config lives.
 */
const QUERIES_DIR = path.resolve(process.cwd(), "config/queries");
const METRIC_CONFIG_FILE = "metric-views.json";

/**
 * Three-part UC FQN matcher. The registry is parsed against the landed
 * `metricSourceSchema`, which already validates `source` via the composed
 * `UC_THREE_PART_FQN_PATTERN`; this is a belt-and-suspenders runtime fence for
 * any code path that constructs SQL from a `source` outside that parse (the FQN
 * cannot be parameterized — it is interpolated into the SQL string).
 */
const FQN_PATTERN =
  /^[a-zA-Z0-9_][a-zA-Z0-9_-]*\.[a-zA-Z0-9_][a-zA-Z0-9_-]*\.[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

/**
 * Validate measure names before they are interpolated into `MEASURE(<m>)`.
 *
 * Measure names cannot be parameterized — they are SQL identifiers, not
 * literals. This conservative identifier shape is the security boundary for
 * the interpolated tokens: there is deliberately NO name allowlist, so a
 * well-formed-but-unknown measure falls through to the warehouse and surfaces
 * as a sanitized canonical error (parity with the raw `.sql` flow).
 */
const MEASURE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Dimension name pattern. Matches the identifier shape we accept for measures
 * — column references cannot be parameterized in SQL, so they must be
 * conservatively safe identifiers (no spaces, no quotes, no SQL operators).
 * This grammar gate is the security boundary for interpolated dimension
 * tokens: there is deliberately NO name allowlist, so a well-formed-but-unknown
 * dimension falls through to the warehouse and surfaces as a sanitized
 * canonical error.
 */
const DIMENSION_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Time-grain token shape. Accepted structurally so a hostile token can never
 * reach the SQL string, but the grain is NOT applied to any SQL this phase —
 * see the seam in {@link renderDimensionClause}.
 */
const TIME_GRAIN_PATTERN = /^[a-z][a-z_]*$/;

/**
 * The exact twelve filter operators allowed at v1. The runtime tuple is the
 * server-side source of truth; the client-side type union
 * `MetricFilterOperatorName` mirrors these names statically.
 */
const METRIC_FILTER_OPERATORS = [
  "equals",
  "notEquals",
  "in",
  "notIn",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "notContains",
  "set",
  "notSet",
] as const satisfies readonly MetricFilterOperatorName[];

/**
 * Maximum AND/OR nesting depth. The PRD documents 8 as a sensible cap —
 * enough for any real BI filter UI, low enough that a hostile or malformed
 * payload cannot stack-overflow the recursive validator or translator.
 *
 * The depth count is the number of nested `{ and }` / `{ or }` wrappers
 * encountered while descending — leaf predicates do not count toward depth.
 */
const METRIC_FILTER_MAX_DEPTH = 8;

/**
 * Cardinality caps on user-controlled arrays. Closes the recurring
 * `unbounded-request-parameters` finding: a hostile caller could otherwise
 * send `values: [...10M items...]` and exhaust the validator + the named
 * bind-var binding step. The limits below are deliberately generous — higher
 * than any real BI UI would emit — so legitimate traffic never trips them.
 */
const METRIC_MEASURES_MAX = 50;
const METRIC_DIMENSIONS_MAX = 20;
const METRIC_FILTER_VALUES_MAX = 1000;
const METRIC_LIMIT_MAX = 100_000;

/**
 * Maximum number of children per AND/OR group node. Without this cap a single
 * flat group like `{ and: [...10M empty objects...] }` would push tens of
 * millions of frames onto the iterative pre-check's stack — OOM before
 * validation even gets to Zod. The Zod schema enforces the same cap so the
 * rejection point is consistent regardless of which validator catches it
 * first.
 */
const METRIC_FILTER_GROUP_MAX = 100;

/** Operators that require exactly one value. */
const SINGLE_VALUE_OPERATORS = new Set<MetricFilterOperatorName>([
  "equals",
  "notEquals",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "notContains",
]);

/** Operators that require at least one value. */
const LIST_VALUE_OPERATORS = new Set<MetricFilterOperatorName>(["in", "notIn"]);

/** Operators that reject `values` entirely. */
const NULL_OPERATORS = new Set<MetricFilterOperatorName>(["set", "notSet"]);

/** Operators that emit `LIKE` / `NOT LIKE` and require a string value. */
const STRING_OPERATORS = new Set<MetricFilterOperatorName>([
  "contains",
  "notContains",
]);

/**
 * Map an entry's declared `executor` to the internal execution lane:
 *   - `"user"`                → `"obo"` (per-user cache, on-behalf-of)
 *   - `"app_service_principal"` (default) → `"sp"` (shared cache)
 */
function laneFromExecutor(
  executor: "app_service_principal" | "user",
): MetricLane {
  return executor === "user" ? "obo" : "sp";
}

/**
 * Read and validate `config/queries/metric-views.json` into a metric registry.
 *
 * Synchronous by design — registration is a pure config parse with no
 * warehouse round-trip, no `DESCRIBE`, and no build-time metadata bundle. The
 * single `metricViews` map makes keys unique by construction, so there is no
 * cross-lane duplicate-key check.
 *
 * Returns an empty registry when the file is absent: the metric-view path is
 * additive and dormant until an app opts in by adding the config. A malformed
 * file (unreadable, invalid JSON, or schema violation) throws — the caller
 * latches the failure so the route can surface a 503 rather than masking a
 * broken deployment as a 404 for every key.
 */
export function loadMetricRegistry(
  queriesDir: string = QUERIES_DIR,
): Record<string, MetricRegistration> {
  const metricPath = path.join(queriesDir, METRIC_CONFIG_FILE);

  let raw: string;
  try {
    raw = fs.readFileSync(metricPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse metric-views.json at ${metricPath}: ${(err as Error).message}`,
    );
  }

  const result = metricSourceSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid metric-views.json at ${metricPath}: ${issues}`);
  }

  const registry: Record<string, MetricRegistration> = {};
  for (const [key, entry] of Object.entries(result.data.metricViews ?? {})) {
    registry[key] = {
      key,
      source: entry.source,
      lane: laneFromExecutor(entry.executor),
    };
  }

  logger.debug(
    "Loaded metric registry: %d entry(ies)",
    Object.keys(registry).length,
  );
  return registry;
}

/**
 * SQL identifier safety guard — the FQN ships in the SQL string (it cannot be
 * parameterized) so we re-check the regex at construction time.
 *
 * The registry loader already enforces the FQN grammar via `metricSourceSchema`;
 * this is a runtime fence for any future code path that constructs SQL outside
 * of a parsed registry.
 */
function assertSafeFqn(fqn: string): void {
  if (!FQN_PATTERN.test(fqn)) {
    throw new Error(
      `Refusing to build SQL: "${fqn}" is not a valid three-part UC FQN.`,
    );
  }
}

/**
 * Structural validation schema for the metric request body.
 *
 * The schema is **static** — any grammar-valid measure/dimension identifier is
 * accepted; it is NOT a dynamic per-key `z.enum(knownMeasures)`. Unknown-but-
 * well-formed names are not rejected here; they reach the warehouse and surface
 * as a sanitized canonical error. The identifier grammar gate is enforced in
 * {@link buildMetricSql}/{@link renderFilter} at interpolation time; the body
 * schema stays structural (item shape, cardinality caps, operator enum,
 * per-operator value cardinality, and AND/OR depth).
 *
 * `filter` is recursive (`Predicate | { and: [...] } | { or: [...] }`), built
 * with `z.lazy`. `timeGrain` is accepted as a grammar-shaped token but its SQL
 * application is deferred (see {@link renderDimensionClause}).
 */

/** A leaf predicate: `{ member, operator, values? }`, no extra keys. */
const filterPredicateSchema: z.ZodType<MetricPredicate> = z
  .object({
    member: z
      .string()
      .min(1, { message: "filter predicate 'member' cannot be empty" }),
    operator: z.string().min(1, {
      message: "filter predicate 'operator' cannot be empty",
    }) as z.ZodType<MetricFilterOperatorName>,
    values: z
      .array(z.union([z.string(), z.number()]))
      .max(METRIC_FILTER_VALUES_MAX, {
        message: `filter predicate 'values' length exceeds the maximum of ${METRIC_FILTER_VALUES_MAX}`,
      })
      .optional(),
  })
  .strict();

/** Recursive filter: a predicate leaf or an `{ and }` / `{ or }` group. */
const filterSchema: z.ZodType<MetricFilter> = z.lazy(() =>
  z.union([
    filterPredicateSchema,
    z
      .object({
        and: z.array(filterSchema).max(METRIC_FILTER_GROUP_MAX, {
          message: `filter 'and' group exceeds the maximum of ${METRIC_FILTER_GROUP_MAX} children`,
        }),
      })
      .strict(),
    z
      .object({
        or: z.array(filterSchema).max(METRIC_FILTER_GROUP_MAX, {
          message: `filter 'or' group exceeds the maximum of ${METRIC_FILTER_GROUP_MAX} children`,
        }),
      })
      .strict(),
  ]),
);

const metricRequestSchema = z
  .object({
    measures: z
      .array(z.string().min(1, "measure name cannot be empty"))
      .min(1, "at least one measure is required")
      .max(METRIC_MEASURES_MAX, {
        message: `measures length exceeds the maximum of ${METRIC_MEASURES_MAX}`,
      }),
    dimensions: z
      .array(z.string().min(1, "dimension name cannot be empty"))
      .max(METRIC_DIMENSIONS_MAX, {
        message: `dimensions length exceeds the maximum of ${METRIC_DIMENSIONS_MAX}`,
      })
      .optional(),
    filter: filterSchema.optional(),
    // Grammar-shaped only: the token is validated for safety but its SQL is
    // not built this phase (grain target TBD).
    timeGrain: z
      .string()
      .min(1, { message: "timeGrain cannot be empty" })
      .regex(TIME_GRAIN_PATTERN, {
        message: "timeGrain must match /^[a-z][a-z_]*$/",
      })
      .optional(),
    limit: z
      .number()
      .int({ message: "limit must be an integer" })
      .positive({ message: "limit must be positive" })
      .max(METRIC_LIMIT_MAX, {
        message: `limit exceeds the maximum of ${METRIC_LIMIT_MAX}`,
      })
      .optional(),
    format: z.enum(["JSON_ARRAY", "ARROW_STREAM", "JSON", "ARROW"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.filter != null) {
      validateFilterTree(value.filter, ctx, ["filter"], 0);
    }
  }) as z.ZodType<IAnalyticsMetricRequest>;

/**
 * Recursive Zod-time validator for the filter tree.
 *
 * Pushes structured issues into the refinement context with stable paths
 * (`filter.and.0.or.2.member`, etc.) so the canonical 400 error carries
 * actionable diagnostics. Keeps the registry-free concerns in one descent:
 *
 *  1. Operator is one of the twelve.
 *  2. Per-operator value cardinality (single / list / null operators).
 *  3. `contains`/`notContains` carry a string value.
 *  4. AND/OR nesting depth cap.
 *
 * There is NO member-allowlist and NO op⇄dimension-type check — the member is
 * grammar-gated at SQL-build time, and dimension types are not tracked (no
 * registry metadata). Returns void; issues accumulate on `ctx`.
 */
function validateFilterTree(
  node: MetricFilter,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  depth: number,
): void {
  if (node === null || typeof node !== "object") {
    // The base schema rejects this via the union, but stay defensive.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "filter node must be a Predicate or { and } / { or } group",
    });
    return;
  }

  if ("and" in node || "or" in node) {
    if (depth + 1 > METRIC_FILTER_MAX_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `filter AND/OR nesting exceeds the maximum depth of ${METRIC_FILTER_MAX_DEPTH}`,
      });
      return;
    }

    const groupKey = "and" in node ? "and" : "or";
    const children = (
      node as { and?: ReadonlyArray<MetricFilter> } & {
        or?: ReadonlyArray<MetricFilter>;
      }
    )[groupKey];

    if (!Array.isArray(children)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, groupKey],
        message: `filter ${groupKey} group must be an array of predicates or nested groups`,
      });
      return;
    }

    // Reject empty `or` groups: an empty disjunction is vacuously false, which
    // silently drops the surrounding intent. Empty `and` is OK (vacuously true
    // → no constraint). Forcing the caller to omit the predicate entirely is
    // the only unambiguous choice.
    if (groupKey === "or" && children.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "or"],
        message: "filter 'or' group must contain at least one predicate",
      });
      return;
    }

    children.forEach((child, idx) => {
      validateFilterTree(child, ctx, [...path, groupKey, idx], depth + 1);
    });
    return;
  }

  // Leaf predicate. The base schema already enforced shape; here we layer in
  // the operator vocabulary + per-operator value cardinality.
  const predicate = node as MetricPredicate;

  if (
    !METRIC_FILTER_OPERATORS.includes(
      predicate.operator as MetricFilterOperatorName,
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, "operator"],
      message: `filter operator "${predicate.operator}" is not one of: ${METRIC_FILTER_OPERATORS.join(", ")}`,
    });
    // No further checks meaningful when the operator is unknown.
    return;
  }

  const op = predicate.operator;
  const values = predicate.values;
  const valuesLen = values?.length ?? 0;

  if (NULL_OPERATORS.has(op)) {
    if (values != null && valuesLen > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "values"],
        message: `filter operator "${op}" must not carry values`,
      });
    }
  } else if (SINGLE_VALUE_OPERATORS.has(op)) {
    if (valuesLen !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "values"],
        message: `filter operator "${op}" requires exactly one value (got ${valuesLen})`,
      });
    }
  } else if (LIST_VALUE_OPERATORS.has(op)) {
    if (valuesLen < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "values"],
        message: `filter operator "${op}" requires at least one value`,
      });
    }
  }

  // Op⇄value-type: string operators require a string value. This is a
  // registry-free structural check (not an op⇄dimension-type check) — it
  // converts what would otherwise be a synchronous throw in `renderPredicate`
  // (rendered as a 500) into a clean 400 at validation time.
  if (STRING_OPERATORS.has(op) && valuesLen > 0) {
    const v = predicate.values?.[0];
    if (typeof v !== "string") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "values"],
        message: `filter operator "${op}" requires a string value (got ${typeof v})`,
      });
    }
  }
}

/**
 * Iterative pre-parse depth check. Zod's union/object parsers walk the input
 * recursively before our `superRefine` depth cap fires, so a deeply-nested
 * `{ and: [{ and: [...] }] }` payload could stack-overflow during parse, never
 * reaching the validator's depth check. This walk is iterative (explicit
 * stack) and aborts as soon as `METRIC_FILTER_MAX_DEPTH` is exceeded, so a
 * hostile payload of any size cannot drive the call stack.
 *
 * Walks BOTH `and` and `or` branches when both are present on the same node —
 * Zod's `.strict()` rejects the multi-key shape downstream, but the pre-check
 * has to inspect every branch Zod might recurse into (an earlier version used
 * `else if` and was bypassed by `{ and: [], or: <deep> }`).
 *
 * Group-children breadth is also capped: a flat `{ and: [...10M items...] }`
 * cannot push 10M frames onto the explicit stack here. Predicate leaves do NOT
 * count toward depth — only nested `and` / `or` wrappers — matching the rule
 * {@link validateFilterTree} enforces.
 */
function preCheckFilterDepth(filter: unknown): void {
  if (filter == null || typeof filter !== "object") return;
  const stack: Array<[unknown, number]> = [[filter, 0]];
  while (stack.length > 0) {
    const popped = stack.pop();
    if (popped === undefined) continue;
    const [node, depth] = popped;
    if (node == null || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    for (const groupKey of ["and", "or"] as const) {
      const children = obj[groupKey];
      if (!Array.isArray(children)) continue;
      if (children.length > METRIC_FILTER_GROUP_MAX) {
        throw new ValidationError(
          "Invalid metric request body (fields: filter)",
          {
            context: {
              reason: `filter ${groupKey} group has ${children.length} children; the maximum is ${METRIC_FILTER_GROUP_MAX}`,
            },
          },
        );
      }
      if (depth + 1 > METRIC_FILTER_MAX_DEPTH) {
        throw new ValidationError(
          "Invalid metric request body (fields: filter)",
          {
            context: {
              reason: `filter AND/OR nesting exceeds the maximum depth of ${METRIC_FILTER_MAX_DEPTH}`,
            },
          },
        );
      }
      for (const child of children) {
        stack.push([child, depth + 1]);
      }
    }
  }
}

/**
 * Validate a `POST /api/analytics/metric/:key` request body against the static
 * structured shape. Throws {@link ValidationError} (a 400 on the canonical
 * error path) with the offending field paths; the raw values stay in telemetry
 * context, never the public body.
 *
 * The recursion depth is bounded BEFORE Zod sees the input — the schema's own
 * depth check fires inside `superRefine`, which only runs after Zod's recursive
 * parse has already walked the tree on the call stack.
 */
export function validateMetricRequest(body: unknown): IAnalyticsMetricRequest {
  if (body != null && typeof body === "object") {
    preCheckFilterDepth((body as { filter?: unknown }).filter);
  }
  const result = metricRequestSchema.safeParse(body);
  if (!result.success) {
    const fieldPaths = result.error.issues
      .map((i) => i.path.join(".") || "(root)")
      .join(", ");
    throw new ValidationError(
      fieldPaths.length > 0
        ? `Invalid metric request body (fields: ${fieldPaths})`
        : "Invalid metric request body",
      { context: { issues: result.error.issues } },
    );
  }
  return result.data;
}

/**
 * Construct the metric SQL.
 *
 * Shape:
 *
 *   SELECT MEASURE(m) AS m[, …][, <dim>…]
 *     FROM <fqn>
 *    [WHERE <filter expression>]
 *    [GROUP BY ALL]
 *    [LIMIT n]
 *
 * Notes:
 *  - Every measure and dimension is gated by {@link MEASURE_NAME_PATTERN} /
 *    {@link DIMENSION_NAME_PATTERN} before it is interpolated (column
 *    references cannot be parameterized — they are SQL identifiers), and the
 *    FQN is re-checked by {@link assertSafeFqn}. There is deliberately NO name
 *    allowlist — the grammar gate is the security boundary. No user-supplied
 *    string reaches the SQL string without passing a grammar gate.
 *  - `GROUP BY ALL` is added when at least one dimension is requested. UC
 *    requires GROUP BY when MEASURE() is mixed with non-aggregated columns;
 *    `GROUP BY ALL` is the documented form that works without re-listing each
 *    dimension.
 *  - The `WHERE` clause is rendered from the recursive filter tree. Every value
 *    flows through Statement Execution's named bind-var path (`:f_<idx>`); no
 *    value is ever interpolated as a literal.
 *  - `timeGrain` currently has NO effect on the emitted SQL — see the seam in
 *    {@link renderDimensionClause}.
 *
 * Returns `{ statement, parameters }` where `parameters` is the named bind-var
 * dictionary the plugin's `query()` consumes.
 */
export function buildMetricSql(
  registration: MetricRegistration,
  request: IAnalyticsMetricRequest,
): {
  statement: string;
  parameters: Record<string, SQLTypeMarker>;
} {
  assertSafeFqn(registration.source);

  if (request.measures.length === 0) {
    throw new Error("buildMetricSql requires at least one measure.");
  }

  for (const m of request.measures) {
    if (!MEASURE_NAME_PATTERN.test(m)) {
      throw new Error(
        `Refusing to build SQL: measure "${m}" is not a valid identifier.`,
      );
    }
  }

  const dimensions = request.dimensions ?? [];
  for (const d of dimensions) {
    if (!DIMENSION_NAME_PATTERN.test(d)) {
      throw new Error(
        `Refusing to build SQL: dimension "${d}" is not a valid identifier.`,
      );
    }
  }

  // Deterministic order so cache keys collapse semantically equivalent calls.
  // Alias each measure to its plain name so result rows have keys matching the
  // registered measure (`{ arr: 1234 }`) rather than the SQL-function
  // serialization Databricks returns by default (`{ "measure(arr)": 1234 }`).
  const measureClauses = [...request.measures]
    .sort()
    .map((m) => `MEASURE(${m}) AS ${m}`);

  const dimensionClauses = [...dimensions]
    .sort()
    .map((d) => renderDimensionClause(d, request.timeGrain));

  const selectList = [...measureClauses, ...dimensionClauses].join(", ");
  const groupByClause = dimensions.length > 0 ? " GROUP BY ALL" : "";

  const limitClause =
    typeof request.limit === "number" && request.limit > 0
      ? ` LIMIT ${Math.floor(request.limit)}`
      : "";

  // Filter translation. Every value is bound through `:f_<idx>` named params;
  // every column identifier is grammar-gated in `renderFilter`. Empty filter or
  // no filter → no WHERE.
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

  const statement = `SELECT ${selectList} FROM ${registration.source}${whereClause}${groupByClause}${limitClause}`;
  return { statement, parameters };
}

/**
 * Mutable counter / depth threaded through {@link renderFilter}. Fresh per
 * `buildMetricSql` call, so two requests never share bind-var indexes.
 */
interface FilterRenderState {
  counter: number;
  depth: number;
}

/**
 * Recursively render a filter tree into a SQL fragment, pushing bind values
 * into `params` keyed by `:f_<idx>` names.
 *
 * Returns `null` for an empty group (no WHERE clause needed). The caller's
 * `buildMetricSql` only emits `WHERE` when this returns a non-null, non-empty
 * fragment. Empty `and: []` collapses to null (SQL's vacuous-truth semantics
 * for AND); empty `or: []` renders `1 = 0` — the validator rejects `or: []`
 * before the SQL builder, but if it slips through we render vacuous-false
 * rather than dropping the predicate silently (defense in depth so a future
 * validator bypass cannot turn `or: []` into "match everything").
 *
 * Defense-in-depth: even though the request body's filter has already been
 * validated, every member name is re-checked against {@link
 * DIMENSION_NAME_PATTERN} here. If validation is ever bypassed, the SQL
 * constructor still refuses to interpolate an unknown-shaped identifier.
 */
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
      if (groupKey === "or") {
        return "1 = 0";
      }
      return null;
    }

    // Sort-before-hash discipline: within a group, predicate leaves are
    // stable-sorted by (member, operator) before contributing to the rendered
    // fragment, so semantically equivalent calls produce the same SQL string
    // and (downstream) the same cache key.
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

  // Leaf predicate — grammar-gate the member and operator, then render.
  const predicate = node as MetricPredicate;

  if (!DIMENSION_NAME_PATTERN.test(predicate.member)) {
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

/**
 * Stable-sort filter children inside an AND/OR group by `(member, operator)`.
 *
 * Predicates carry both fields and sort by their pair; nested groups sort
 * after predicates and stay in their original relative order (a nested group
 * is opaque from the outside — we cannot collapse it to a single key). This is
 * the sort-before-hash invariant applied at the SQL-fragment level so
 * downstream cache keys collapse semantically equivalent calls.
 */
function sortFilterChildren(
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
      key = `${p.member}${p.operator}`;
      isPredicate = true;
    } else {
      // Nested groups don't have a single (member, operator) — keep their
      // original index so multiple nested groups within the same parent remain
      // stable relative to each other.
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

/**
 * Translate a single predicate into a SQL fragment.
 *
 * Every value flows through a freshly-allocated `:f_<idx>` named bind var.
 * Nothing from the request body is ever interpolated as a literal — the
 * fragment carries identifiers (grammar-gated) and operators (whitelisted),
 * then references the bind name for each value.
 *
 * `set` and `notSet` emit `IS NULL` / `IS NOT NULL` with no bind value. `in`
 * and `notIn` emit `IN (:f_0, :f_1, ...)`. `contains` and `notContains` emit
 * `LIKE :f_0` / `NOT LIKE :f_0` and pre-bind the value with `%` wrapping.
 */
function renderPredicate(
  predicate: MetricPredicate,
  params: Record<string, SQLTypeMarker>,
  state: FilterRenderState,
): string {
  const col = predicate.member;
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
      // Exhaustiveness — the operator union is closed; if this is reached the
      // operator vocabulary widened without updating the switch.
      const _exhaustive: never = op;
      throw new Error(
        `Refusing to build SQL: unhandled filter operator "${_exhaustive as string}".`,
      );
    }
  }
}

/**
 * Allocate a fresh `:f_<idx>` bind name for `value`, push the typed marker into
 * `params`, and return the placeholder string. Bumps the counter.
 */
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

/**
 * Like {@link bindValue}, but wraps the value in `%...%` for `LIKE` /
 * `NOT LIKE`. SQL wildcards in the user-supplied string remain in the value
 * (matching the documented "contains" semantics) — escape-on-receive could be
 * added later as an opt-in if customers request strict-substring matching.
 */
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

/**
 * Render a single SELECT-list clause for a dimension.
 *
 * timeGrain application deferred — see PR2 grain-target decision; dimension
 * renders bare for now. When the grain target is settled, a time-typed
 * dimension will render as `date_trunc('<grain>', <col>) AS <col>` here; the
 * `timeGrain` token is already accepted (grammar-shaped) upstream so the wire
 * contract is stable across that change.
 */
function renderDimensionClause(
  dim: string,
  _timeGrain: string | undefined,
): string {
  return dim;
}
