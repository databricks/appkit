import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type SQLTypeMarker, sql as sqlHelpers } from "shared";
import { z } from "zod";
import { ValidationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type {
  IAnalyticsMetricRequest,
  MetricDimensionTypeClass,
  MetricFilter,
  MetricFilterOperatorName,
  MetricLane,
  MetricPredicate,
  MetricRegistration,
} from "./types";

const logger = createLogger("analytics:metric");

/**
 * The exact twelve filter operators allowed at v1. The runtime tuple is the
 * server-side source of truth; the client-side type union
 * `MetricFilterOperator` mirrors these names statically.
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
 * bind-var binding step. The limits below are deliberately generous —
 * higher than any real BI UI would emit — so legitimate traffic never trips
 * them. If a customer scenario needs more, expose a per-metric override.
 */
const METRIC_MEASURES_MAX = 50;
const METRIC_DIMENSIONS_MAX = 20;
const METRIC_FILTER_VALUES_MAX = 1000;
const METRIC_LIMIT_MAX = 100_000;

/**
 * Range ops — require numeric or date-typed dimensions. The remaining ops
 * split into:
 *   - any-type: equals, notEquals, in, notIn, set, notSet
 *   - string-only: contains, notContains
 */
const RANGE_OPERATORS = new Set<MetricFilterOperatorName>([
  "gt",
  "gte",
  "lt",
  "lte",
]);

/** String ops — require string-typed dimensions. */
const STRING_OPERATORS = new Set<MetricFilterOperatorName>([
  "contains",
  "notContains",
]);

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

/**
 * Default queries directory. Mirrors `AppManager.queriesDir` so dev mode and
 * production share a single source of truth.
 */
const QUERIES_DIR = path.resolve(process.cwd(), "config/queries");
const METRIC_CONFIG_FILE = "metric.json";
/**
 * Default location of the build-time metadata bundle emitted by
 * `metric sync` and the Vite type-generator plugin. The path mirrors the
 * default `metricMetadataOutFile` in `packages/appkit/src/type-generator/`.
 */
const METRIC_METADATA_PATH = path.resolve(
  process.cwd(),
  "shared/appkit-types/metrics.metadata.json",
);

const METRIC_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const FQN_PATTERN =
  /^[a-zA-Z0-9_][a-zA-Z0-9_-]*\.[a-zA-Z0-9_][a-zA-Z0-9_-]*\.[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

/**
 * v1 entry shape — only `source` is allowed. Future per-entry options grow
 * additively without breaking changes.
 */
const metricEntrySchema = z
  .object({
    source: z.string().regex(FQN_PATTERN, {
      message:
        "metric.source must be a three-part UC FQN <catalog>.<schema>.<metric_view>",
    }),
  })
  .strict();

const metricLaneSchema = z
  .record(
    z.string().regex(METRIC_KEY_PATTERN, {
      message:
        "metric key must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ (letters, digits, underscores; cannot start with a digit)",
    }),
    metricEntrySchema,
  )
  .optional();

/** Top-level shape of metric.json. */
const metricConfigSchema = z
  .object({
    $schema: z.string().optional(),
    sp: metricLaneSchema,
    obo: metricLaneSchema,
  })
  .strict();

/**
 * Per-metric metadata threaded from the type-generator into the runtime
 * registry. Phase 1 supplied measures + dimensions; Phase 2 adds the
 * per-dim time-grain map for time-typed dimensions.
 *
 * Internal to this module — the type-generator wires the JSON metadata blob
 * (Phase 5) into `loadMetricRegistry` via the inferred function parameter
 * shape, so external consumers never name this interface directly.
 */
interface MetricBuildTimeMetadata {
  measures?: string[];
  dimensions?: string[];
  /**
   * Dimension name → allowed time-grains. Only populated for time-typed
   * dimensions; regular dimensions are absent from this map.
   */
  timeGrainsByDim?: Record<string, string[]>;
  /**
   * Dimension name → SQL type. Drives op-vs-type compatibility checks in the
   * filter validator. Empty/missing → validator falls open on type checks.
   */
  dimensionTypes?: Record<string, string>;
}

/**
 * Read the build-time metadata bundle (`metrics.metadata.json`) emitted by
 * `metric sync` / the Vite type-generator plugin, and transform it into the
 * shape `loadMetricRegistry` expects.
 *
 * Returns `null` when the file is absent — apps that haven't run `metric sync`
 * fall back to the validator's open mode. Logs and returns null on parse
 * failures so a stale bundle never takes the server down.
 */
async function readMetricsMetadataBundle(
  metadataPath: string = METRIC_METADATA_PATH,
): Promise<Record<string, MetricBuildTimeMetadata> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(metadataPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    logger.warn(
      "Failed to read metrics.metadata.json at %s: %s",
      metadataPath,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      "metrics.metadata.json at %s is not valid JSON: %s",
      metadataPath,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const result: Record<string, MetricBuildTimeMetadata> = {};
  for (const [metricKey, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const measuresObj =
      v.measures && typeof v.measures === "object" && !Array.isArray(v.measures)
        ? (v.measures as Record<string, unknown>)
        : {};
    const dimensionsObj =
      v.dimensions &&
      typeof v.dimensions === "object" &&
      !Array.isArray(v.dimensions)
        ? (v.dimensions as Record<string, unknown>)
        : {};

    const measures = Object.keys(measuresObj).sort();
    const dimensions = Object.keys(dimensionsObj).sort();

    const timeGrainsByDim: Record<string, string[]> = {};
    const dimensionTypes: Record<string, string> = {};
    for (const [dimName, dimMeta] of Object.entries(dimensionsObj)) {
      if (!dimMeta || typeof dimMeta !== "object") continue;
      const m = dimMeta as Record<string, unknown>;
      if (typeof m.type === "string") {
        dimensionTypes[dimName] = m.type;
      }
      if (Array.isArray(m.time_grain)) {
        const grains = m.time_grain.filter(
          (g): g is string => typeof g === "string",
        );
        if (grains.length > 0) {
          timeGrainsByDim[dimName] = grains;
        }
      }
    }

    result[metricKey] = {
      measures,
      dimensions,
      timeGrainsByDim,
      dimensionTypes,
    };
  }

  return result;
}

/**
 * Read and validate `config/queries/metric.json`.
 *
 * Returns an empty registry when the file is absent — the metric-view path is
 * additive; apps that never adopt metric views must not pay any cost.
 *
 * The optional `metadata` argument carries build-time-extracted measure /
 * dimension names produced by the type-generator. When omitted, the registry
 * still loads but `knownMeasures` is empty and the validator can only do
 * structural checks.
 */
export async function loadMetricRegistry(
  metadata?: Record<string, MetricBuildTimeMetadata>,
  queriesDir: string = QUERIES_DIR,
): Promise<Record<string, MetricRegistration>> {
  const metricPath = path.join(queriesDir, METRIC_CONFIG_FILE);

  // Auto-discover the build-time metadata bundle if the caller didn't
  // pass one explicitly. This wires up Phase 5's metrics.metadata.json
  // to the server-side validator so it knows which dimensions are time-
  // typed (and therefore which `timeGrain` values to accept).
  const resolvedMetadata =
    metadata ?? (await readMetricsMetadataBundle()) ?? undefined;

  let raw: string;
  try {
    raw = await fs.readFile(metricPath, "utf8");
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
      `Failed to parse metric.json at ${metricPath}: ${(err as Error).message}`,
    );
  }

  const result = metricConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid metric.json at ${metricPath}: ${issues}`);
  }

  const registry: Record<string, MetricRegistration> = {};
  const lanes: Array<[MetricLane, Record<string, { source: string }>]> = [
    ["sp", result.data.sp ?? {}],
    ["obo", result.data.obo ?? {}],
  ];

  for (const [lane, laneMap] of lanes) {
    for (const [key, entry] of Object.entries(laneMap)) {
      if (key in registry) {
        throw new Error(
          `Duplicate metric key "${key}": cannot appear in both sp and obo lanes.`,
        );
      }
      const meta = resolvedMetadata?.[key];
      registry[key] = {
        key,
        source: entry.source,
        lane,
        knownMeasures: meta?.measures ?? [],
        knownDimensions: meta?.dimensions ?? [],
        knownTimeGrainsByDim: meta?.timeGrainsByDim ?? {},
        knownDimensionTypes: meta?.dimensionTypes,
      };
    }
  }

  logger.debug(
    "Loaded metric registry: %d entry(ies)",
    Object.keys(registry).length,
  );
  return registry;
}

/**
 * Build a zod schema for the request body of POST /api/analytics/metric/:key.
 *
 * The schema is dynamic per metric: when `knownMeasures` is non-empty the
 * `measures` array is constrained to that set. When empty (no build-time
 * metadata available) any non-empty string is accepted and validation defers
 * to the warehouse.
 *
 * Phase 3 body shape: `{ measures, dimensions?, timeGrain?, filter?, format?, limit? }`.
 *
 * Validation matrix:
 *  - `measures` — must be a non-empty array; constrained to `knownMeasures`
 *    when build-time metadata is available.
 *  - `dimensions` — optional array; constrained to `knownDimensions`.
 *  - `timeGrain` — optional string; constrained to the union of grains
 *    declared across all time-typed dimensions; rejected unless the
 *    `dimensions` array contains at least one time-typed dimension.
 *  - `filter` — optional recursive AND/OR tree of predicates; `member`
 *    constrained to `knownDimensions`; `operator` constrained to the v1
 *    twelve; op⇄type compatibility enforced when dimension types are
 *    available; values cardinality enforced per operator; AND/OR depth
 *    capped at {@link METRIC_FILTER_MAX_DEPTH}.
 */
export function makeMetricRequestSchema(
  registration: MetricRegistration,
): z.ZodType<IAnalyticsMetricRequest> {
  const baseMeasureSchema = z
    .string()
    .min(1, { message: "measure name cannot be empty" });

  // When the registry has build-time metadata, narrow the measure schema to
  // the declared measure names. Use a refinement (rather than `z.enum`) so we
  // can construct the schema dynamically at runtime.
  const knownMeasures = registration.knownMeasures;
  const measureItemSchema =
    knownMeasures.length > 0
      ? baseMeasureSchema.refine(
          (name: string) => knownMeasures.includes(name),
          {
            message: `measure must be one of: ${knownMeasures.join(", ")}`,
          },
        )
      : baseMeasureSchema;

  const knownDimensions = registration.knownDimensions;
  const baseDimensionSchema = z
    .string()
    .min(1, { message: "dimension name cannot be empty" });
  const dimensionItemSchema =
    knownDimensions.length > 0
      ? baseDimensionSchema.refine(
          (name: string) => knownDimensions.includes(name),
          {
            message: `dimension must be one of: ${knownDimensions.join(", ")}`,
          },
        )
      : baseDimensionSchema;

  // Aggregate the union of grains the metric view supports. Empty union means
  // no time-typed dimensions are declared — `timeGrain` cannot be set.
  const grainsByDim = registration.knownTimeGrainsByDim;
  const allowedGrains = collectAllowedGrains(grainsByDim);
  const baseTimeGrainSchema = z
    .string()
    .min(1, { message: "timeGrain cannot be empty" });
  const timeGrainSchema =
    allowedGrains.length > 0
      ? baseTimeGrainSchema.refine((g: string) => allowedGrains.includes(g), {
          message: `timeGrain must be one of: ${allowedGrains.join(", ")}`,
        })
      : baseTimeGrainSchema;

  // ── Filter sub-schema (Phase 3) ──────────────────────────────────────────
  //
  // The filter shape is recursive (`Predicate | { and: [...] } | { or: [...] }`).
  // Zod's recursive support uses `z.lazy(() => ...)` — the depth cap and the
  // op⇄type compatibility check live in a `superRefine` on the parent (so we
  // can walk the tree once with full context).
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

  const filterSchema: z.ZodType<MetricFilter> = z.lazy(() =>
    z.union([
      filterPredicateSchema,
      z
        .object({
          and: z.array(filterSchema),
        })
        .strict(),
      z
        .object({
          or: z.array(filterSchema),
        })
        .strict(),
    ]),
  );

  const knownDimensionTypes = registration.knownDimensionTypes ?? {};

  const baseObject = z
    .object({
      measures: z
        .array(measureItemSchema)
        .min(1, { message: "measures must contain at least one entry" })
        .max(METRIC_MEASURES_MAX, {
          message: `measures length exceeds the maximum of ${METRIC_MEASURES_MAX}`,
        }),
      dimensions: z
        .array(dimensionItemSchema)
        .max(METRIC_DIMENSIONS_MAX, {
          message: `dimensions length exceeds the maximum of ${METRIC_DIMENSIONS_MAX}`,
        })
        .optional(),
      timeGrain: timeGrainSchema.optional(),
      filter: filterSchema.optional(),
      format: z.enum(["JSON", "ARROW"]).optional(),
      limit: z
        .number()
        .int({ message: "limit must be an integer" })
        .positive({ message: "limit must be positive" })
        .max(METRIC_LIMIT_MAX, {
          message: `limit exceeds the maximum of ${METRIC_LIMIT_MAX}`,
        })
        .optional(),
    })
    .strict();

  // Cross-field rules:
  //  1. timeGrain is meaningless without a time-typed dimension in the
  //     dimensions list. Failing fast here keeps the SQL constructor honest
  //     (no `date_trunc(<grain>, <col>)` without a real column to truncate).
  //  2. The recursive `filter` tree is depth-walked once: every predicate's
  //     member must be a registered dimension; every operator must be one of
  //     the twelve; op⇄type compatibility is enforced when dimension types
  //     are available; values cardinality is enforced per operator; AND/OR
  //     nesting is capped at METRIC_FILTER_MAX_DEPTH.
  return baseObject.superRefine((value, ctx) => {
    // Cross-field rule for timeGrain. Tight check whenever the registry has
    // ANY dimension metadata: if the metric has dims registered but none are
    // time-typed (`grainsByDim` empty), `timeGrain` is meaningless on this
    // metric and we reject. The pure-fall-open path now only fires when no
    // dimension metadata is available at all — which the route's fail-closed
    // gate (`knownMeasures.length === 0` → 503) prevents in practice.
    if (value.timeGrain != null && knownDimensions.length > 0) {
      const grainsByDimKeys = Object.keys(grainsByDim);
      if (grainsByDimKeys.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["timeGrain"],
          message:
            "timeGrain specified but the metric has no time-typed dimensions",
        });
      } else {
        const dims = value.dimensions ?? [];
        const hasTimeDim = dims.some(
          (d) => Array.isArray(grainsByDim[d]) && grainsByDim[d].length > 0,
        );
        if (!hasTimeDim) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["timeGrain"],
            message:
              "timeGrain specified but no time-typed dimension is included in 'dimensions'",
          });
        }
      }
    }

    if (value.filter != null) {
      validateFilterTree(value.filter, ctx, ["filter"], 0, {
        knownDimensions,
        knownDimensionTypes,
      });
    }
  }) as z.ZodType<IAnalyticsMetricRequest>;
}

/**
 * Recursive zod-time validator for the filter tree.
 *
 * Pushes structured issues into the zod refinement context with stable paths
 * (`filter.and.0.or.2.member`, etc.) so the canonical 400 error shape carries
 * actionable diagnostics. Keeps three concerns in one descent:
 *
 *  1. Member is a registered dimension (when registry has metadata).
 *  2. Operator is one of the twelve; values cardinality matches.
 *  3. Op⇄type compatibility (string ops on string-typed dims, range ops on
 *     numeric/date-typed dims, equality/set/null ops on any type).
 *  4. Depth cap (AND/OR nesting limit).
 *
 * Returns void; issues are accumulated on `ctx`. The caller's
 * `safeParse(...).success` flips false when any issue is added.
 */
function validateFilterTree(
  node: MetricFilter,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  depth: number,
  registry: {
    knownDimensions: string[];
    knownDimensionTypes: Record<string, string>;
  },
): void {
  if (node === null || typeof node !== "object") {
    // The base schema rejects this case earlier via the union, but be
    // defensive in case a future refactor leaves the door ajar.
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

    // Reject empty `or` groups: SQL-wise an empty disjunction is vacuously
    // false, which silently drops the surrounding intent. Empty `and` is OK
    // (vacuously true → no constraint contributed). Forcing the caller to
    // omit the predicate entirely is the only unambiguous choice.
    if (groupKey === "or" && children.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "or"],
        message: "filter 'or' group must contain at least one predicate",
      });
      return;
    }

    children.forEach((child, idx) => {
      validateFilterTree(
        child,
        ctx,
        [...path, groupKey, idx],
        depth + 1,
        registry,
      );
    });
    return;
  }

  // Leaf predicate. The base schema already enforced shape; here we layer in
  // the registry-aware constraints.
  const predicate = node as MetricPredicate;

  if (
    registry.knownDimensions.length > 0 &&
    !registry.knownDimensions.includes(predicate.member)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, "member"],
      message: `filter member "${predicate.member}" is not a declared dimension (allowed: ${registry.knownDimensions.join(", ")})`,
    });
  }

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

  // Op⇄type compatibility — only enforced when we have a registered type.
  // Falls open (no error) when the registry didn't supply a type for the dim.
  const declaredType = registry.knownDimensionTypes[predicate.member];
  if (declaredType) {
    const cls = classifyDimensionType(declaredType);
    if (RANGE_OPERATORS.has(op) && cls === "string") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "operator"],
        message: `filter operator "${op}" is incompatible with string-typed dimension "${predicate.member}"`,
      });
    }
    if (STRING_OPERATORS.has(op) && cls !== "string" && cls !== "unknown") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "operator"],
        message: `filter operator "${op}" is incompatible with non-string dimension "${predicate.member}" (type ${declaredType})`,
      });
    }
  }

  // Op⇄value-type compatibility. Catches the malformed-value case at
  // validation time (returns 400) instead of letting it surface as a
  // synchronous Error from `buildMetricSql` (which would render as 500).
  // String operators always require a string value regardless of the
  // dimension's declared type. Range operators require a numeric value when
  // the dim is numeric — date-typed dims accept ISO date strings, so we
  // don't tighten there.
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
  if (
    RANGE_OPERATORS.has(op) &&
    declaredType &&
    classifyDimensionType(declaredType) === "numeric" &&
    valuesLen > 0
  ) {
    const v = predicate.values?.[0];
    if (typeof v !== "number") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "values"],
        message: `filter operator "${op}" on numeric dimension "${predicate.member}" requires a numeric value (got ${typeof v})`,
      });
    }
  }
}

/**
 * Classify a Databricks SQL type string into a coarse compatibility class.
 *
 * The classification is conservative: `STRING` and adjacent text types map to
 * `string`; numeric, integral, and float types map to `numeric`; `DATE` and
 * `TIMESTAMP` map to `date`; everything else maps to `unknown`. Accepting the
 * fallback as `unknown` lets the validator stay deterministic when the
 * registry has no type metadata for the dim.
 */
function classifyDimensionType(sqlType: string): MetricDimensionTypeClass {
  const normalized = sqlType
    .toUpperCase()
    .replace(/\(.*\)$/, "")
    .replace(/<.*>$/, "")
    .split(" ")[0];

  switch (normalized) {
    case "STRING":
    case "VARCHAR":
    case "CHAR":
    case "TEXT":
      return "string";
    case "TINYINT":
    case "SMALLINT":
    case "INT":
    case "INTEGER":
    case "BIGINT":
    case "FLOAT":
    case "DOUBLE":
    case "DECIMAL":
    case "NUMERIC":
      return "numeric";
    case "DATE":
    case "TIMESTAMP":
    case "TIMESTAMP_NTZ":
    case "TIMESTAMP_LTZ":
      return "date";
    default:
      return "unknown";
  }
}

/**
 * Aggregate the set of allowed time-grains across every time-typed dimension.
 *
 * Sorted + deduplicated so the validator's error messages and the cache-key
 * construction are deterministic.
 */
function collectAllowedGrains(grainsByDim: Record<string, string[]>): string[] {
  const set = new Set<string>();
  for (const grains of Object.values(grainsByDim)) {
    for (const g of grains) {
      set.add(g);
    }
  }
  return [...set].sort();
}

/**
 * Validate the request body against the metric's schema.
 *
 * Returns the parsed body on success; throws {@link ValidationError} with the
 * canonical 400 shape on failure. Throwing keeps the route handler simple —
 * the AppKit error pipeline handles the response shape.
 *
 * The thrown error's public `message` carries only the offending field paths
 * (`measures.0`, `filter.and.0.member`, etc.) — never the registry's allowed
 * values or the metric's measure/dimension names. The full Zod issue list,
 * including allowlists embedded in per-issue messages, is preserved on
 * `context.issues` for server-side telemetry. This prevents an unauthenticated
 * caller from enumerating the registered schema by sending malformed bodies.
 */
/**
 * Per-registration Zod schema cache. The schema is recursive (filter tree
 * with `z.lazy`) and constructs ~10 chained refinements, which is non-trivial
 * to rebuild on every request. Keyed on the registration object so the cache
 * empties automatically when the registry is reloaded (e.g., dev hot-reload
 * of `metric.json`) — old registration objects become unreferenced and the
 * `WeakMap` entry is garbage-collected.
 */
const metricRequestSchemaCache = new WeakMap<
  MetricRegistration,
  z.ZodType<IAnalyticsMetricRequest>
>();

export function validateMetricRequest(
  registration: MetricRegistration,
  body: unknown,
): IAnalyticsMetricRequest {
  let schema = metricRequestSchemaCache.get(registration);
  if (schema === undefined) {
    schema = makeMetricRequestSchema(registration);
    metricRequestSchemaCache.set(registration, schema);
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const fieldPaths = result.error.issues
      .map((i) => i.path.join(".") || "(root)")
      .join(", ");
    throw new ValidationError(
      fieldPaths.length > 0
        ? `Invalid metric request body (fields: ${fieldPaths})`
        : "Invalid metric request body",
      {
        context: {
          metric: registration.key,
          issues: result.error.issues,
        },
      },
    );
  }
  return result.data;
}

/**
 * SQL identifier safety guard — the FQN ships in the SQL string (it cannot be
 * parameterized) so we belt-and-suspender the regex check at construction time.
 *
 * The build-time loader already enforces FQN_PATTERN; this is a runtime fence
 * for any future code path that constructs SQL outside of the registry.
 */
function assertSafeFqn(fqn: string): void {
  if (!FQN_PATTERN.test(fqn)) {
    throw new Error(
      `Refusing to build SQL: "${fqn}" is not a valid three-part UC FQN.`,
    );
  }
}

/**
 * Validate measure names before they are interpolated into MEASURE(<m>).
 *
 * Measure names cannot be parameterized — they are SQL identifiers, not
 * literals. We restrict to a conservative identifier shape and assert
 * presence in the build-time registry when known.
 */
const MEASURE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Dimension name pattern. Matches the identifier shape we accept for measures
 * — column references cannot be parameterized in SQL, so they must be
 * conservatively safe identifiers (no spaces, no quotes, no SQL operators).
 */
const DIMENSION_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Time-grain enum values that are safe to interpolate into `date_trunc()`.
 * The build-time metadata supplies these as YAML 1.1 lowercase tokens — we
 * only accept that shape; anything else (mixed case, quoted strings,
 * SQL operators) is rejected before reaching the SQL string.
 */
const TIME_GRAIN_PATTERN = /^[a-z][a-z_]*$/;

/**
 * Construct the Phase 3 metric SQL.
 *
 * Shape:
 *
 *   SELECT MEASURE(m), date_trunc('<grain>', <time_dim>) AS <time_dim>, <dim>
 *     FROM <fqn>
 *    [WHERE <filter expression>]
 *    [GROUP BY ALL]
 *    [LIMIT n]
 *
 * Notes:
 *  - All column references (measures, dimensions, filter members) are
 *    validated against the registry and against the conservative identifier
 *    pattern. No user-supplied string flows into the SQL string without
 *    passing both gates.
 *  - `date_trunc('<grain>', col) AS col` is emitted for every time-typed
 *    dimension when `timeGrain` is set. The grain literal is single-quoted in
 *    the SQL — we cannot use a bind variable for `date_trunc`'s first
 *    argument, so we restrict to the registry's allowed grain enum.
 *  - `GROUP BY ALL` is added when at least one dimension is requested. UC
 *    requires GROUP BY when MEASURE() is mixed with non-aggregated columns;
 *    `GROUP BY ALL` is the documented form that works without re-listing each
 *    dimension.
 *  - `WHERE` clause is rendered from the recursive filter tree. Every value
 *    flows through Statement Execution's named bind-var path (`:f_<idx>`);
 *    no value is ever interpolated as a literal. Member identifiers come
 *    from the validated registry, not the request body.
 *
 * Returns `{ statement, parameters }` where `parameters` is the named
 * bind-var dictionary the analytics plugin's `query()` method consumes.
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
    if (
      registration.knownMeasures.length > 0 &&
      !registration.knownMeasures.includes(m)
    ) {
      throw new Error(
        `Refusing to build SQL: unknown measure "${m}" for metric "${registration.key}".`,
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
    if (
      registration.knownDimensions.length > 0 &&
      !registration.knownDimensions.includes(d)
    ) {
      throw new Error(
        `Refusing to build SQL: unknown dimension "${d}" for metric "${registration.key}".`,
      );
    }
  }

  if (request.timeGrain !== undefined) {
    if (!TIME_GRAIN_PATTERN.test(request.timeGrain)) {
      throw new Error(
        `Refusing to build SQL: timeGrain "${request.timeGrain}" is not a valid grain token.`,
      );
    }
    const allowed = collectAllowedGrains(registration.knownTimeGrainsByDim);
    if (allowed.length > 0 && !allowed.includes(request.timeGrain)) {
      throw new Error(
        `Refusing to build SQL: unknown timeGrain "${request.timeGrain}" for metric "${registration.key}".`,
      );
    }
    // Same fall-open rule as the validator: only enforce when metadata is
    // available. Without registry knowledge we trust the warehouse to reject
    // an incompatible grain at SQL execution time.
    if (Object.keys(registration.knownTimeGrainsByDim).length > 0) {
      const hasTimeDim = dimensions.some((d) =>
        isTimeTypedDim(registration, d),
      );
      if (!hasTimeDim) {
        throw new Error(
          `Refusing to build SQL: timeGrain "${request.timeGrain}" set but no time-typed dimension is in 'dimensions'.`,
        );
      }
    }
  }

  // Deterministic order so cache keys collapse semantically equivalent calls.
  // Sort-before-hash composition is finalized in Phase 4; sorting the SELECT
  // list here is the same idea applied to the SQL itself.
  // Alias each measure to its plain name so result rows have keys matching
  // the registered measure (`{ arr: 1234 }`) rather than the SQL-function
  // serialization Databricks returns by default (`{ "measure(arr)": 1234 }`).
  // The measure name has already been validated against MEASURE_NAME_PATTERN
  // and the registry's known measure list, so it's safe to interpolate.
  const measureClauses = [...request.measures]
    .sort()
    .map((m) => `MEASURE(${m}) AS ${m}`);

  const dimensionClauses = [...dimensions]
    .sort()
    .map((d) => renderDimensionClause(registration, d, request.timeGrain));

  const selectList = [...measureClauses, ...dimensionClauses].join(", ");
  const groupByClause = dimensions.length > 0 ? " GROUP BY ALL" : "";

  const limitClause =
    typeof request.limit === "number" && request.limit > 0
      ? ` LIMIT ${Math.floor(request.limit)}`
      : "";

  // Filter translation. Every value is bound through `:f_<idx>` named params;
  // every column identifier is gated by the registry-membership check above
  // (recursively, via `renderFilter`). Empty filter or no filter → no WHERE.
  const parameters: Record<string, SQLTypeMarker> = {};
  let whereClause = "";
  if (request.filter !== undefined) {
    const fragment = renderFilter(request.filter, registration, parameters, {
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
 * `buildMetricSql` only emits `WHERE` when this returns a non-null,
 * non-empty fragment. Empty `and: []` and `or: []` groups collapse to null —
 * matching SQL's vacuous-truth semantics for AND, and the validator-permitted
 * "no predicates" shape.
 *
 * Defense-in-depth: even though the request body's filter has already been
 * validated by the zod schema, every member name is re-checked against the
 * registry here. If validation is ever bypassed, the SQL constructor still
 * refuses to interpolate an unknown identifier.
 */
function renderFilter(
  node: MetricFilter,
  registration: MetricRegistration,
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
      // Empty AND → vacuously true, render as no constraint (null).
      // Empty OR → vacuously false. The validator rejects this case before
      // reaching the SQL builder, but if it slips through, render `1 = 0`
      // rather than dropping the predicate silently — defense in depth so a
      // future validator bypass cannot turn `or: []` into "match everything".
      if (groupKey === "or") {
        return "1 = 0";
      }
      return null;
    }

    // Sort-before-hash discipline (Phase 3 incremental). Within a group,
    // predicate leaves are stable-sorted by (member, operator) before
    // contributing to the rendered fragment, so semantically equivalent calls
    // produce the same SQL string and (downstream) the same cache key.
    const sortedChildren = sortFilterChildren(children);

    const fragments: string[] = [];
    const childState: FilterRenderState = {
      counter: state.counter,
      depth: state.depth + 1,
    };
    for (const child of sortedChildren) {
      const rendered = renderFilter(child, registration, params, childState);
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

  // Leaf predicate — validate against the registry one more time, then render.
  const predicate = node as MetricPredicate;

  if (!DIMENSION_NAME_PATTERN.test(predicate.member)) {
    throw new Error(
      `Refusing to build SQL: filter member "${predicate.member}" is not a valid identifier.`,
    );
  }
  if (
    registration.knownDimensions.length > 0 &&
    !registration.knownDimensions.includes(predicate.member)
  ) {
    throw new Error(
      `Refusing to build SQL: unknown filter member "${predicate.member}" for metric "${registration.key}".`,
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
 * is opaque from the outside — we cannot collapse it to a single key). This
 * is the sort-before-hash invariant applied at the SQL-fragment level so
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
      key = `${p.member} ${p.operator}`;
      isPredicate = true;
    } else {
      // Nested groups don't have a single (member, operator) — keep their
      // original index so multiple nested groups within the same parent
      // remain stable relative to each other.
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
 * fragment carries identifiers (registry-validated) and operators
 * (whitelisted), then references the bind name for each value.
 *
 * `set` and `notSet` emit `IS NULL` / `IS NOT NULL` with no bind value.
 * `in` and `notIn` emit `IN (:f_0, :f_1, ...)`. `contains` and `notContains`
 * emit `LIKE :f_0` and pre-bind the value with `%` wrapping.
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
      // Exhaustiveness — the operator union is closed; if this is reached
      // the operator vocabulary widened without updating the switch.
      const _exhaustive: never = op;
      throw new Error(
        `Refusing to build SQL: unhandled filter operator "${_exhaustive as string}".`,
      );
    }
  }
}

/**
 * Allocate a fresh `:f_<idx>` bind name for `value`, push the typed marker
 * into `params`, and return the placeholder string. Bumps the counter.
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
 * (matching the documented "contains" semantics) — escape-on-receive could
 * be added later as an opt-in if customers request strict-substring matching.
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
 * Whether a dimension name is registered as time-typed (carries a non-empty
 * `time_grain` attribute in the YAML).
 */
function isTimeTypedDim(
  registration: MetricRegistration,
  dim: string,
): boolean {
  const grains = registration.knownTimeGrainsByDim[dim];
  return Array.isArray(grains) && grains.length > 0;
}

/**
 * Render a single SELECT-list clause for a dimension.
 *
 * Time-typed dimensions are wrapped in `date_trunc('<grain>', <col>) AS <col>`
 * when `timeGrain` is set; non-time dimensions render as the bare column name.
 *
 * The grain literal is whitelisted by `collectAllowedGrains(registration)` and
 * the column name has already passed the identifier-pattern guard above, so
 * neither flows through user-controlled bytes.
 */
function renderDimensionClause(
  registration: MetricRegistration,
  dim: string,
  timeGrain: string | undefined,
): string {
  if (timeGrain && isTimeTypedDim(registration, dim)) {
    return `date_trunc('${timeGrain}', ${dim}) AS ${dim}`;
  }
  return dim;
}

/**
 * Compose the cache key — final Phase 4 form.
 *
 * Reserved namespace `metric:` separates metric-view caches from query
 * caches. The key shape is `metric:{metric_key}:{argsHash}:{executorKey}`,
 * where:
 *  - `metric_key` is the registry's stable map key (readable in debug logs).
 *  - `argsHash` is a deterministic serialization of the request body's
 *    canonical form. Order-insensitive components are sorted before they
 *    contribute to the hash so semantically equivalent calls collapse to the
 *    same cache entry.
 *  - `executorKey` is `"sp"` for SP-lane entries and a sha256 hash of the
 *    end-user's identity for OBO-lane entries. The raw identity is never
 *    placed in the cache key (privacy concern: cache stores log keys).
 *
 * Sort-before-hash applies to:
 *  - `measures`: lexicographic sort
 *  - `dimensions`: lexicographic sort
 *  - `filter`: predicates inside each AND/OR group are stable-sorted by
 *    `(member, operator)`; group kind (`and` vs `or`) is preserved by
 *    {@link canonicalizeFilter}
 *
 * The returned array is consumed by `CacheManager.generateKey` which
 * concatenates and sha256-hashes the parts. The structure (one element per
 * concern) makes the cache key inspectable in tests and debug logs without
 * giving up determinism.
 */
export function composeMetricCacheKey(input: {
  metricKey: string;
  measures: string[];
  dimensions?: string[];
  timeGrain?: string;
  filter?: MetricFilter;
  format: string;
  executorKey: string;
  limit?: number;
}): string[] {
  const sortedMeasures = [...input.measures].sort();
  const sortedDimensions = [...(input.dimensions ?? [])].sort();
  const filterFingerprint =
    input.filter !== undefined ? canonicalizeFilter(input.filter) : "_";
  return [
    "metric",
    input.metricKey,
    input.format,
    sortedMeasures.join(","),
    sortedDimensions.join(","),
    input.timeGrain ?? "_",
    filterFingerprint,
    typeof input.limit === "number" ? String(input.limit) : "_",
    input.executorKey,
  ];
}

/**
 * Derive the cache executor key from a metric registration's lane and the
 * caller's user identity.
 *
 * Returns `"sp"` for SP-lane entries (every caller shares the cache) and a
 * sha256 hex digest of the user identity for OBO-lane entries (each user
 * gets an isolated cache scope).
 *
 * The user identity is hashed — never stored verbatim — so the cache layer
 * (which logs keys at debug level and persists them in any cache backend)
 * never sees raw user emails or principal names. A stable, opaque token is
 * what we need: same user → same key (so cache hits work), different users
 * → different keys (so isolation holds), and reverse lookup is infeasible.
 *
 * For a missing or empty identity, falls back to a literal `"anonymous"`
 * sentinel rather than an empty string. Empty-string hashes would collide
 * across all callers without an identity — which is the bug a privacy-aware
 * design must prevent.
 */
export function deriveMetricExecutorKey(input: {
  lane: MetricLane;
  userIdentity?: string | null;
}): string {
  if (input.lane === "sp") {
    return "sp";
  }
  // OBO lane — hash the user identity so the raw email/principal never
  // reaches the cache layer. `anonymous` is a sentinel for when the request
  // has no resolvable identity (in practice this should not happen because
  // OBO requires `x-forwarded-user`, but we belt-and-suspender it here).
  const identity = input.userIdentity?.trim();
  const subject = identity && identity.length > 0 ? identity : "anonymous";
  return createHash("sha256").update(subject).digest("hex");
}

/**
 * Produce a deterministic string fingerprint of the filter tree.
 *
 * The fingerprint sorts predicates within each AND/OR group by
 * `(member, operator)` and recursively canonicalizes nested groups. Values
 * are included verbatim so cache entries differ when the filter targets
 * different values (`region in [EMEA]` vs `region in [APAC]` — different
 * keys; `equals A` vs `equals B` — different keys), while order-insensitive
 * predicate lists collapse to the same key.
 */
function canonicalizeFilter(node: MetricFilter): string {
  if (node === null || typeof node !== "object") {
    return "_";
  }

  if ("and" in node || "or" in node) {
    const groupKey = "and" in node ? "and" : "or";
    const children = (
      node as { and?: ReadonlyArray<MetricFilter> } & {
        or?: ReadonlyArray<MetricFilter>;
      }
    )[groupKey];

    if (!Array.isArray(children) || children.length === 0) {
      return `${groupKey}()`;
    }

    const sorted = sortFilterChildren(children);
    const childFingerprints = sorted.map(canonicalizeFilter);
    return `${groupKey}(${childFingerprints.join(",")})`;
  }

  // Leaf predicate. Use JSON.stringify (not String) for the value segment so
  // strings carrying the `|` separator cannot collide with split arrays —
  // e.g. `["a", "b"]` and `["a|string:b"]` are now distinct fingerprints.
  const p = node as MetricPredicate;
  const valuesPart = p.values
    ? p.values.map((v) => `${typeof v}:${JSON.stringify(v)}`).join("|")
    : "";
  return `p(${p.member}/${p.operator}/${valuesPart})`;
}
