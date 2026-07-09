import fs from "node:fs";
import path from "node:path";
import type { SQLTypeMarker } from "shared";
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
  MetricLane,
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
 * The schema is **static** — any grammar-valid measure identifier is accepted;
 * it is NOT a dynamic per-key `z.enum(knownMeasures)`. Unknown-but-well-formed
 * names are not rejected here; they reach the warehouse and surface as a
 * sanitized canonical error. This is the measures-only shape;
 * dimensions/filter/timeGrain are accepted structurally (their SQL is built in
 * a later phase) but left permissive here.
 */
const metricRequestSchema = z
  .object({
    measures: z
      .array(z.string().min(1, "measure name cannot be empty"))
      .min(1, "at least one measure is required"),
    dimensions: z.array(z.string().min(1)).optional(),
    filter: z.unknown().optional(),
    timeGrain: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
    format: z.enum(["JSON_ARRAY", "ARROW_STREAM", "JSON", "ARROW"]).optional(),
  })
  .strict();

/**
 * Validate a `POST /api/analytics/metric/:key` request body against the static
 * measures-only shape. Throws {@link ValidationError} (a 400 on the canonical
 * error path) with the offending field paths; the raw values stay in telemetry
 * context, never the public body.
 */
export function validateMetricRequest(body: unknown): IAnalyticsMetricRequest {
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
 * Construct the measures-only metric SQL.
 *
 * Shape:
 *
 *   SELECT MEASURE(m) AS m[, …] FROM <fqn> [LIMIT n]
 *
 * Every measure is gated by {@link MEASURE_NAME_PATTERN} before it is
 * interpolated (measures cannot be parameterized — they are SQL identifiers),
 * and the FQN is re-checked by {@link assertSafeFqn}. No user-supplied string
 * reaches the SQL string without passing a grammar gate. `dimensions`,
 * `filter`, and `timeGrain` are ignored here — their SQL is built in a later
 * phase. Returns `{ statement, parameters }` where `parameters` is the named
 * bind-var dictionary the plugin's `query()` consumes (empty in this phase).
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

  // Deterministic order so cache keys collapse semantically equivalent calls.
  // Alias each measure to its plain name so result rows have keys matching the
  // registered measure (`{ arr: 1234 }`) rather than the SQL-function
  // serialization Databricks returns by default (`{ "measure(arr)": 1234 }`).
  const measureClauses = [...request.measures]
    .sort()
    .map((m) => `MEASURE(${m}) AS ${m}`);

  const selectList = measureClauses.join(", ");

  const limitClause =
    typeof request.limit === "number" && request.limit > 0
      ? ` LIMIT ${Math.floor(request.limit)}`
      : "";

  const statement = `SELECT ${selectList} FROM ${registration.source}${limitClause}`;
  return { statement, parameters: {} };
}
