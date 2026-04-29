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
  metadata?: Record<string, { measures?: string[]; dimensions?: string[] }>,
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
 * Phase 1 body shape: `{ measures, format?, limit? }`. Phase 2/3 widen this.
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

  return z
    .object({
      measures: z
        .array(measureItemSchema)
        .min(1, { message: "measures must contain at least one entry" }),
      format: z.enum(["JSON", "ARROW"]).optional(),
      limit: z
        .number()
        .int({ message: "limit must be an integer" })
        .positive({ message: "limit must be positive" })
        .optional(),
    })
    .strict() as z.ZodType<IAnalyticsMetricRequest>;
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
 * Construct the Phase 1 metric SQL.
 *
 * Shape: `SELECT MEASURE(m1), MEASURE(m2) FROM <fqn> [LIMIT n]`.
 *
 * Phase 1 has no dimensions, no filter, no GROUP BY, no time-grain. Each of
 * those is a follow-on phase with its own dedicated test surface. The intent
 * here is the integration spine, not a feature-rich generator.
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

  // Deterministic order so cache keys collapse semantically equivalent calls.
  // Sort-before-hash composition is finalized in Phase 4; sorting the SELECT
  // list here is the same idea applied to the SQL itself.
  const measureClauses = [...request.measures]
    .sort()
    .map((m) => `MEASURE(${m})`)
    .join(", ");

  const limitClause =
    typeof request.limit === "number" && request.limit > 0
      ? ` LIMIT ${Math.floor(request.limit)}`
      : "";

  const statement = `SELECT ${measureClauses} FROM ${registration.source}${limitClause}`;
  return { statement, parameters: [] };
}

/**
 * Compose the Phase 1 cache key.
 *
 * Reserved namespace `metric:` separates metric-view caches from query
 * caches. Phase 4 finalizes sort-before-hash composition; Phase 1 only needs
 * the namespace to be reserved + a stable per-key/per-args/per-executor key
 * so the cache test surface works.
 */
export function composeMetricCacheKey(input: {
  metricKey: string;
  measures: string[];
  format: string;
  executorKey: string;
  limit?: number;
}): string[] {
  const sortedMeasures = [...input.measures].sort();
  return [
    "metric",
    input.metricKey,
    input.format,
    sortedMeasures.join(","),
    typeof input.limit === "number" ? String(input.limit) : "_",
    input.executorKey,
  ];
}
