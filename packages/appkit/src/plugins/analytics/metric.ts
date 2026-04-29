import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ValidationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type {
  IAnalyticsMetricRequest,
  MetricLane,
  MetricRegistration,
} from "./types";

const logger = createLogger("analytics:metric");

/**
 * Default queries directory. Mirrors `AppManager.queriesDir` so dev mode and
 * production share a single source of truth.
 */
const QUERIES_DIR = path.resolve(process.cwd(), "config/queries");
const METRIC_CONFIG_FILE = "metric.json";

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
      const meta = metadata?.[key];
      registry[key] = {
        key,
        source: entry.source,
        lane,
        knownMeasures: meta?.measures ?? [],
        knownDimensions: meta?.dimensions ?? [],
        knownTimeGrainsByDim: meta?.timeGrainsByDim ?? {},
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
 * Phase 2 body shape: `{ measures, dimensions?, timeGrain?, format?, limit? }`.
 *
 * Validation matrix:
 *  - `measures` — must be a non-empty array; constrained to `knownMeasures`
 *    when build-time metadata is available.
 *  - `dimensions` — optional array; constrained to `knownDimensions`.
 *  - `timeGrain` — optional string; constrained to the union of grains
 *    declared across all time-typed dimensions; rejected unless the
 *    `dimensions` array contains at least one time-typed dimension.
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

  const baseObject = z
    .object({
      measures: z
        .array(measureItemSchema)
        .min(1, { message: "measures must contain at least one entry" }),
      dimensions: z.array(dimensionItemSchema).optional(),
      timeGrain: timeGrainSchema.optional(),
      format: z.enum(["JSON", "ARROW"]).optional(),
      limit: z
        .number()
        .int({ message: "limit must be an integer" })
        .positive({ message: "limit must be positive" })
        .optional(),
    })
    .strict();

  // Cross-field rule: timeGrain is meaningless without a time-typed dimension
  // in the dimensions list. Failing fast here keeps the SQL constructor
  // honest (no `date_trunc(<grain>, <col>)` without a real column to truncate).
  return baseObject.superRefine((value, ctx) => {
    if (value.timeGrain == null) return;
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
  }) as z.ZodType<IAnalyticsMetricRequest>;
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
 */
export function validateMetricRequest(
  registration: MetricRegistration,
  body: unknown,
): IAnalyticsMetricRequest {
  const schema = makeMetricRequestSchema(registration);
  const result = schema.safeParse(body);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ValidationError(`Invalid metric request body: ${detail}`, {
      context: {
        metric: registration.key,
        issues: result.error.issues,
      },
    });
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
 * Construct the Phase 2 metric SQL.
 *
 * Shape:
 *
 *   SELECT MEASURE(m), date_trunc('<grain>', <time_dim>) AS <time_dim>, <dim>
 *     FROM <fqn>
 *    [GROUP BY ALL]
 *    [LIMIT n]
 *
 * Notes:
 *  - All column references (measures, dimensions) are validated against the
 *    registry's `knownMeasures` / `knownDimensions` and against the conservative
 *    identifier pattern. No user-supplied string flows into the SQL string
 *    without passing both gates.
 *  - `date_trunc('<grain>', col) AS col` is emitted for every time-typed
 *    dimension when `timeGrain` is set. The grain literal is single-quoted in
 *    the SQL — we cannot use a bind variable for `date_trunc`'s first
 *    argument, so we restrict to the registry's allowed grain enum.
 *  - `GROUP BY ALL` is added when at least one dimension is requested. UC
 *    requires GROUP BY when MEASURE() is mixed with non-aggregated columns;
 *    `GROUP BY ALL` is the documented form that works without re-listing each
 *    dimension.
 */
export function buildMetricSql(
  registration: MetricRegistration,
  request: IAnalyticsMetricRequest,
): { statement: string; parameters: never[] } {
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
    const hasTimeDim = dimensions.some((d) => isTimeTypedDim(registration, d));
    if (!hasTimeDim) {
      throw new Error(
        `Refusing to build SQL: timeGrain "${request.timeGrain}" set but no time-typed dimension is in 'dimensions'.`,
      );
    }
  }

  // Deterministic order so cache keys collapse semantically equivalent calls.
  // Sort-before-hash composition is finalized in Phase 4; sorting the SELECT
  // list here is the same idea applied to the SQL itself.
  const measureClauses = [...request.measures]
    .sort()
    .map((m) => `MEASURE(${m})`);

  const dimensionClauses = [...dimensions]
    .sort()
    .map((d) => renderDimensionClause(registration, d, request.timeGrain));

  const selectList = [...measureClauses, ...dimensionClauses].join(", ");
  const groupByClause = dimensions.length > 0 ? " GROUP BY ALL" : "";

  const limitClause =
    typeof request.limit === "number" && request.limit > 0
      ? ` LIMIT ${Math.floor(request.limit)}`
      : "";

  const statement = `SELECT ${selectList} FROM ${registration.source}${groupByClause}${limitClause}`;
  return { statement, parameters: [] };
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
 * Compose the cache key.
 *
 * Reserved namespace `metric:` separates metric-view caches from query
 * caches. Phase 4 finalizes sort-before-hash composition with the full
 * argsHash / executorKey discipline; Phase 2's incremental need is for the
 * key to vary on dimensions + timeGrain so semantically distinct calls get
 * distinct cache entries.
 *
 * Order-insensitive components (measures, dimensions) are sorted before
 * hashing into the key string, matching the PRD's sort-before-hash invariant.
 */
export function composeMetricCacheKey(input: {
  metricKey: string;
  measures: string[];
  dimensions?: string[];
  timeGrain?: string;
  format: string;
  executorKey: string;
  limit?: number;
}): string[] {
  const sortedMeasures = [...input.measures].sort();
  const sortedDimensions = [...(input.dimensions ?? [])].sort();
  return [
    "metric",
    input.metricKey,
    input.format,
    sortedMeasures.join(","),
    sortedDimensions.join(","),
    input.timeGrain ?? "_",
    typeof input.limit === "number" ? String(input.limit) : "_",
    input.executorKey,
  ];
}
