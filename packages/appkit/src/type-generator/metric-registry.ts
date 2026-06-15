import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type { DatabricksStatementExecutionResponse } from "./types";

/**
 * Default filename for the metric source declarations.
 * Lives at config/queries/metric-views.json by convention.
 *
 * Absence of the file means the metric-view path is dormant —
 * {@link readMetricConfig} returns `null` silently (no fallback to any legacy
 * filename, no log noise).
 */
const METRIC_CONFIG_FILE = "metric-views.json";

/**
 * Input caps enforced by {@link resolveMetricConfig}.
 *
 * Inline-only at v1: the canonical Zod schema
 * (`packages/shared/src/schemas/metric-source.ts`) carries no caps yet —
 * aligning it is a PR4 rider, so the parity suite deliberately excludes cap
 * fixtures until then.
 *
 * - `MAX_METRIC_VIEWS` bounds the `metricViews` map so a pathological config
 *   cannot fan out thousands of DESCRIBE statements per generation pass.
 * - `MAX_FQN_SEGMENT_LENGTH` mirrors Unity Catalog's 255-character
 *   identifier limit per FQN part.
 * - `MAX_FQN_LENGTH` bounds the full dotted name (3 × 255 + 2 separators).
 */
const MAX_METRIC_VIEWS = 200;
const MAX_FQN_SEGMENT_LENGTH = 255;
const MAX_FQN_LENGTH = 767;

/**
 * Locale-independent comparator (UTF-16 code-unit order) shared by BOTH
 * artifact key orderings: {@link resolveMetricConfig}'s entry sort (which the
 * `.d.ts` renderer preserves) and {@link buildMetricsMetadataBundle}'s key
 * sort. `localeCompare` (ICU-backed collation) can order mixed-case keys
 * differently across machines and locales; code-unit order cannot — so the
 * emitted `metric.d.ts` and `metrics.metadata.json` key order is always
 * identical.
 */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The lane an entry sits in: `sp` (service principal, shared cache)
 * or `obo` (on-behalf-of, per-user cache).
 *
 * Lanes are internal vocabulary — the config speaks `executor`
 * ("app_service_principal" | "user") and {@link resolveMetricConfig} derives
 * the lane at the parse boundary.
 */
export type MetricLane = "sp" | "obo";

/**
 * Single entry in the `metricViews` map of metric-views.json.
 *
 * v1 allows `source` plus the optional `executor`. Object form (rather than
 * bare string) is the forward-compat seam for future per-entry options
 * (cacheTtl, defaultFilter, ...) — `executor` is the first such option.
 */
interface MetricEntryConfig {
  source: string;
  executor?: "app_service_principal" | "user";
}

/**
 * Shape of metric-views.json (mirrors `metricSourceSchema` in
 * `packages/shared/src/schemas/metric-source.ts`). Inlined here so the
 * type-generator does not pull in the shared schema package at runtime.
 */
interface MetricSourceConfig {
  $schema?: string;
  metricViews?: Record<string, MetricEntryConfig>;
}

/**
 * Resolved entry consumed by the rest of the metric-view pipeline.
 * Lane is denormalized onto the entry so downstream code does not have to
 * re-derive it from the config's `executor` field.
 */
interface ResolvedMetricEntry {
  /** Stable map key shared across route, hook, registry, and cache. */
  key: string;
  /** Three-part Unity Catalog FQN of the metric view. */
  source: string;
  /** Execution lane — sp = service principal, obo = on-behalf-of. */
  lane: MetricLane;
}

/**
 * Per-column metadata extracted from DESCRIBE TABLE EXTENDED ... AS JSON.
 *
 * Phase 1 captured measure flags + types. Phase 2 widens to time-typed
 * dimensions: grain qualification is inferred from the column's SQL type
 * (TIMESTAMP* / DATE) — the UC metric-view YAML schema has no per-column
 * `time_grain` attribute, so the type is the only signal available.
 *
 * Phase 5 captures the YAML 1.1 semantic-metadata fields so the build-time
 * artifact is a complete record of what the metric view declares: display name
 * (used by `formatLabel` to render axis titles / legend entries / tooltips),
 * format spec (printf-like string consumed by `formatValue` and `toD3Format`),
 * and description (column-level documentation). All three are optional in the
 * YAML; the extractor leaves the field undefined when absent.
 */
export interface MetricColumnMetadata {
  name: string;
  type: string;
  /** UC marks columns produced by `MEASURE()` as measures; everything else is a dimension. */
  isMeasure: boolean;
  /** Optional column comment / display description (best-effort). */
  description?: string;
  /**
   * Human-readable display name from the YAML 1.1 `display_name` attribute.
   * Used by `formatLabel` as the canonical axis / legend / tooltip text;
   * absent → callers fall back to camelCase / snake_case humanization of `name`.
   */
  displayName?: string;
  /**
   * Printf-style format spec from the YAML 1.1 `format` attribute (e.g.
   * `"$#,##0.00"`, `"0.0%"`, `"#,##0"`). `formatValue` and `toD3Format`
   * consume this passthrough — the framework deliberately does not invent a
   * format DSL; we forward the YAML's verbatim string and fall back to
   * sensible defaults when the spec is absent or unrecognized.
   */
  format?: string;
  /**
   * Standard time-grain set for this column, inferred from the SQL data type:
   *   TIMESTAMP* → 7 grains (minute..year); DATE → 5 grains (day..year).
   * Undefined means the column is not time-typed. Measures never get grains.
   */
  timeGrains?: string[];
}

/**
 * Per-metric schema captured at type-generation time.
 *
 * The full row type is the union of measure + dimension column types. Phase 1
 * uses only `measures`; Phase 2 widens to `dimensions` and `timeGrains`.
 */
export interface MetricSchema {
  /** Stable metric key (the map key under `metricViews` in metric-views.json). */
  key: string;
  /** Three-part FQN of the metric view. */
  source: string;
  /** Execution lane this metric was registered under. */
  lane: MetricLane;
  /** Measure columns (those exposed by MEASURE()). */
  measures: MetricColumnMetadata[];
  /** Dimension columns (everything that is not a measure). */
  dimensions: MetricColumnMetadata[];
  /**
   * `true` when the schema is unknown — the warehouse couldn't tell us
   * (DESCRIBE was skipped, returned a non-terminal state, was rejected, or
   * its response couldn't be parsed into columns). Absent/`false` means the
   * measures/dimensions are a real DESCRIBE result, including a genuinely
   * column-light view (e.g. dimensions only).
   *
   * Degraded entries render permissive types (`string` unions, permissive
   * row) so an app still compiles while the warehouse is unavailable;
   * non-degraded entries keep exact (possibly `never`) unions. Orthogonal to
   * {@link MetricSyncFailure}: `failures` drives loud reporting, `degraded`
   * drives permissive rendering. Plain JSON-safe boolean so the schema can be
   * serialized into a future typegen cache verbatim.
   */
  degraded?: boolean;
}

/**
 * Result of reading and resolving metric-views.json — a flat entries list
 * with the lane denormalized for iteration.
 */
interface MetricConfigResolution {
  entries: ResolvedMetricEntry[];
}

/**
 * Read metric-views.json from a queries folder.
 *
 * Returns `null` if the file does not exist (the metric-view path is
 * additive — apps without metric-views.json must not be penalized). There is
 * deliberately no fallback to the legacy `metric.json` filename.
 *
 * Throws on JSON parse errors so misconfiguration surfaces loudly.
 */
export async function readMetricConfig(
  queryFolder: string,
): Promise<MetricSourceConfig | null> {
  const metricPath = path.join(queryFolder, METRIC_CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(metricPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
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

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Invalid metric-views.json at ${metricPath}: expected an object with a 'metricViews' map.`,
    );
  }

  return parsed as MetricSourceConfig;
}

/**
 * Validate a key against the JSON Schema's metricKey pattern. Kept
 * lightweight — the shared Zod schema (`metricSourceSchema`) is the canonical
 * contract for IDE/CI; this regex is identical to its `metricKeySchema`.
 */
function isValidMetricKey(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}

/**
 * Validate a UC FQN against the shared schema's source pattern.
 */
function isValidFqn(fqn: string): boolean {
  return /^[a-zA-Z0-9_][a-zA-Z0-9_-]*\.[a-zA-Z0-9_][a-zA-Z0-9_-]*\.[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(
    fqn,
  );
}

/**
 * Resolve the `metricViews` map into a flat list of entries.
 *
 * The internal lane is derived from each entry's `executor` at this parse
 * boundary: `"user"` → `obo`; `"app_service_principal"` or absent → `sp`.
 * Downstream consumers only ever see lanes.
 *
 * Throws on unknown top-level fields, invalid keys, non-object entries,
 * unknown entry fields, invalid FQNs, invalid executors, or inputs exceeding
 * the v1 caps ({@link MAX_METRIC_VIEWS} entries, {@link MAX_FQN_LENGTH} /
 * {@link MAX_FQN_SEGMENT_LENGTH} FQN bounds). A single map makes duplicate
 * metric keys unrepresentable by construction. Stable ordering: by key in
 * locale-independent code-unit order (see {@link compareKeys}).
 */
export function resolveMetricConfig(
  config: MetricSourceConfig,
): MetricConfigResolution {
  // v1 explicitly rejects unknown top-level fields so the legacy sp/obo lane
  // shape (and future additions) cannot be silently consumed today.
  const allowedTopLevel = new Set(["$schema", "metricViews"]);
  for (const field of Object.keys(config)) {
    if (!allowedTopLevel.has(field)) {
      throw new Error(
        `Invalid top-level field "${field}" in metric-views.json: only '$schema' and 'metricViews' are allowed.`,
      );
    }
  }

  // Default ONLY a genuinely-absent `metricViews`. `null` must fall through
  // to the type check below and throw — the canonical Zod schema rejects null
  // (`.optional()` admits undefined only) and the inline validator agrees.
  const metricViews =
    config.metricViews === undefined ? {} : config.metricViews;
  if (
    typeof metricViews !== "object" ||
    metricViews === null ||
    Array.isArray(metricViews)
  ) {
    throw new Error(
      `Invalid 'metricViews' in metric-views.json: expected an object map of metric entries.`,
    );
  }

  const entries: ResolvedMetricEntry[] = [];
  const sortedKeys = Object.keys(metricViews).sort(compareKeys);
  if (sortedKeys.length > MAX_METRIC_VIEWS) {
    throw new Error(
      `Invalid 'metricViews' in metric-views.json: ${sortedKeys.length} metric views exceed the maximum of ${MAX_METRIC_VIEWS}.`,
    );
  }
  for (const key of sortedKeys) {
    if (!isValidMetricKey(key)) {
      throw new Error(
        `Invalid metric key "${key}" in metricViews: must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
      );
    }

    const entry = metricViews[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `Invalid metric entry "${key}": expected an object with a 'source' field.`,
      );
    }

    // v1 explicitly rejects unknown entry fields so future additions cannot
    // be silently consumed today.
    const allowed = new Set(["source", "executor"]);
    for (const field of Object.keys(entry)) {
      if (!allowed.has(field)) {
        throw new Error(
          `Invalid field "${field}" on metric entry "${key}": only 'source' and 'executor' are allowed at v1.`,
        );
      }
    }

    if (typeof entry.source !== "string" || entry.source.trim() === "") {
      throw new Error(
        `Invalid metric entry "${key}": 'source' must be a non-empty string.`,
      );
    }

    // Total-length cap BEFORE the regex so the pattern only ever runs on
    // bounded input. The offending FQN is reported by length, not echoed —
    // it can be arbitrarily long.
    if (entry.source.length > MAX_FQN_LENGTH) {
      throw new Error(
        `Invalid metric source for "${key}": FQN is ${entry.source.length} characters, exceeding the maximum of ${MAX_FQN_LENGTH}.`,
      );
    }

    if (!isValidFqn(entry.source)) {
      throw new Error(
        `Invalid metric source "${entry.source}" for "${key}": expected a three-part UC FQN <catalog>.<schema>.<metric_view>.`,
      );
    }

    // The regex guarantees exactly three dot-joined segments; cap each at
    // UC's identifier limit.
    const segments = entry.source.split(".");
    const segmentNames = ["catalog", "schema", "metric_view"];
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].length > MAX_FQN_SEGMENT_LENGTH) {
        throw new Error(
          `Invalid metric source for "${key}": the ${segmentNames[i]} segment is ${segments[i].length} characters, exceeding the maximum of ${MAX_FQN_SEGMENT_LENGTH} per segment.`,
        );
      }
    }

    const executor = entry.executor;
    if (
      executor !== undefined &&
      executor !== "app_service_principal" &&
      executor !== "user"
    ) {
      throw new Error(
        `Invalid executor "${String(executor)}" on metric entry "${key}": must be "app_service_principal" or "user".`,
      );
    }

    const lane: MetricLane = executor === "user" ? "obo" : "sp";

    entries.push({ key, source: entry.source, lane });
  }

  return { entries };
}

/**
 * Parse the JSON payload returned by DESCRIBE TABLE EXTENDED ... AS JSON.
 *
 * The Statement Execution API returns a single string cell — this normalizer
 * unwraps it. Handles both the production (real warehouse) shape and the
 * shape produced by mocked test responses.
 *
 * Precondition: the statement reached a terminal state. {@link syncMetrics}
 * classifies non-terminal responses (PENDING/RUNNING — a stopped or
 * cold-starting warehouse that outlived `wait_timeout`) as degraded before
 * calling this, so the "returned no rows" error below only ever describes a
 * SUCCEEDED statement that genuinely produced no rows (a wrong FQN), never
 * warehouse readiness.
 */
export function parseDescribeTableExtendedJson(
  response: DatabricksStatementExecutionResponse,
): unknown {
  if (response.status?.state === "FAILED") {
    const msg = response.status.error?.message ?? "DESCRIBE failed";
    throw new Error(`DESCRIBE TABLE EXTENDED failed: ${msg}`);
  }

  const rows = response.result?.data_array ?? [];
  if (rows.length === 0) {
    throw new Error(
      "DESCRIBE TABLE EXTENDED returned no rows. Verify the FQN points to a metric view.",
    );
  }

  const cell = rows[0]?.[0];
  if (typeof cell !== "string") {
    throw new Error(
      "DESCRIBE TABLE EXTENDED first cell was not a JSON string. Confirm the AS JSON suffix is supported.",
    );
  }

  try {
    return JSON.parse(cell);
  } catch (err) {
    throw new Error(
      `Failed to parse DESCRIBE TABLE EXTENDED JSON: ${(err as Error).message}`,
    );
  }
}

/**
 * Pure function: turn the parsed DESCRIBE JSON into structured column metadata.
 *
 * Tolerant of multiple JSON shapes (the field may be `columns` or `schema.fields`,
 * type may be a string or `{ name }` object, the measure marker may be `is_measure`
 * or under `metadata.is_measure`). Phase 1's job is to find names + measure flags;
 * later phases can tighten this if a more authoritative shape stabilizes.
 */
export function extractMetricColumns(parsed: unknown): MetricColumnMetadata[] {
  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const root = parsed as Record<string, unknown>;
  const columnsCandidate = (root.columns ??
    (root.schema && typeof root.schema === "object"
      ? (root.schema as Record<string, unknown>).fields
      : undefined)) as unknown;

  if (!Array.isArray(columnsCandidate)) {
    return [];
  }

  const columns: MetricColumnMetadata[] = [];
  for (const raw of columnsCandidate) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const name =
      typeof obj.name === "string"
        ? obj.name
        : typeof obj.column_name === "string"
          ? obj.column_name
          : undefined;
    if (!name) continue;

    const typeRaw = obj.type ?? obj.data_type ?? obj.type_name;
    let type = "STRING";
    if (typeof typeRaw === "string") {
      type = typeRaw;
    } else if (typeRaw && typeof typeRaw === "object") {
      const inner = (typeRaw as Record<string, unknown>).name;
      if (typeof inner === "string") type = inner;
    }

    let isMeasure = false;
    if (typeof obj.is_measure === "boolean") {
      isMeasure = obj.is_measure;
    } else if (
      obj.metadata &&
      typeof obj.metadata === "object" &&
      typeof (obj.metadata as Record<string, unknown>).is_measure === "boolean"
    ) {
      isMeasure = (obj.metadata as Record<string, unknown>)
        .is_measure as boolean;
    } else if (obj.kind === "measure" || obj.role === "measure") {
      isMeasure = true;
    }

    const description =
      typeof obj.comment === "string"
        ? obj.comment
        : typeof obj.description === "string"
          ? obj.description
          : undefined;

    const displayName = extractStringFromAny(obj, [
      "display_name",
      "displayName",
    ]);
    const format = extractFormatString(obj);

    // Time-grain inference is type-driven, not YAML-attribute-driven.
    // Earlier versions of this code looked for a `time_grain` field on each
    // column, but that field does not exist in UC's metric-view schema —
    // the Rust serde at universe/reyden/metric-view-serde/src/v11/column.rs
    // enumerates the 7 known column properties (window, expr, format,
    // display_name, name, comment, synonyms). CREATE rejects `time_grain`
    // with "Unrecognized field". Measures don't get grouped, so skip them.
    const timeGrains = isMeasure ? undefined : inferTimeGrains(type);

    columns.push({
      name,
      type,
      isMeasure,
      description,
      ...(displayName ? { displayName } : {}),
      ...(format ? { format } : {}),
      ...(timeGrains ? { timeGrains } : {}),
    });
  }

  return columns;
}

/**
 * Read a non-empty string attribute from a DESCRIBE column entry, tolerating
 * the multiple shapes UC has shipped for this metadata over time.
 *
 * For each candidate name, we check the column object directly, then under
 * `metadata.<name>`. The first non-empty trimmed string wins. Empty / missing
 * → undefined (the caller leaves the field off the emitted artifact).
 */
function extractStringFromAny(
  obj: Record<string, unknown>,
  candidates: readonly string[],
): string | undefined {
  for (const key of candidates) {
    const direct = obj[key];
    if (typeof direct === "string" && direct.trim().length > 0) {
      return direct;
    }
    const meta = obj.metadata;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const nested = (meta as Record<string, unknown>)[key];
      if (typeof nested === "string" && nested.trim().length > 0) {
        return nested;
      }
    }
  }
  return undefined;
}

/**
 * Read the column's `format` attribute from a DESCRIBE entry and return a
 * printf-like format string suitable for `formatValue` and `toD3Format`.
 *
 * Tolerates two source shapes:
 *
 *   1. **Legacy / hand-authored** — `format: "$#,##0.00"` (already a printf
 *      string). Returned as-is.
 *
 *   2. **YAML 1.1 structured** — DESCRIBE TABLE EXTENDED ... AS JSON for a
 *      UC Metric View wraps the column's format type as the outer key:
 *
 *      ```
 *      { "currency": { "decimal_places": { "places": 2 }, "currency_code": "USD" } }
 *      { "percent":  { "decimal_places": { "places": 1 } } }
 *      { "number":   { "decimal_places": { "places": 0 } } }
 *      ```
 *
 * Both shapes are checked at top-level (`obj.format` / `obj.format_spec`)
 * and under `metadata.<name>` for parity with extractStringFromAny.
 *
 * Unrecognized objects return undefined; downstream consumers fall back to
 * default locale formatting.
 */
function extractFormatString(obj: Record<string, unknown>): string | undefined {
  for (const key of ["format", "format_spec"]) {
    const direct = obj[key];
    const fromDirect = formatStringFromValue(direct);
    if (fromDirect) return fromDirect;

    const meta = obj.metadata;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const nested = (meta as Record<string, unknown>)[key];
      const fromMeta = formatStringFromValue(nested);
      if (fromMeta) return fromMeta;
    }
  }
  return undefined;
}

function formatStringFromValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return translateStructuredFormat(value as Record<string, unknown>);
  }
  return undefined;
}

/**
 * Translate the structured `format` object emitted by DESCRIBE TABLE EXTENDED
 * AS JSON into a printf-like format string. Recognizes the three YAML 1.1
 * shapes; returns undefined for anything else.
 */
function translateStructuredFormat(
  spec: Record<string, unknown>,
): string | undefined {
  if (spec.currency && typeof spec.currency === "object") {
    return currencyFormatString(spec.currency as Record<string, unknown>);
  }
  if (spec.percent && typeof spec.percent === "object") {
    return percentFormatString(spec.percent as Record<string, unknown>);
  }
  if (spec.number && typeof spec.number === "object") {
    return numberFormatString(spec.number as Record<string, unknown>);
  }
  return undefined;
}

function currencyFormatString(c: Record<string, unknown>): string {
  const places = readDecimalPlaces(c) ?? 2;
  const codeRaw = c.currency_code;
  const code =
    typeof codeRaw === "string" && codeRaw.trim().length > 0
      ? codeRaw.toUpperCase()
      : "USD";
  const symbol = currencySymbol(code);
  return `${symbol}#,##0${fractionalSuffix(places)}`;
}

function percentFormatString(p: Record<string, unknown>): string {
  const places = readDecimalPlaces(p) ?? 0;
  return `0${fractionalSuffix(places)}%`;
}

function numberFormatString(n: Record<string, unknown>): string {
  const places = readDecimalPlaces(n) ?? 0;
  return `#,##0${fractionalSuffix(places)}`;
}

function fractionalSuffix(places: number): string {
  return places > 0 ? `.${"0".repeat(places)}` : "";
}

/**
 * Maximum decimal places honored from a format spec. `Number#toFixed` (the
 * digit-count primitive downstream formatters render fractional suffixes
 * with) throws a RangeError above 100 fraction digits, and the emitted
 * printf string would carry a pathological zero-run. Clamp, do NOT throw:
 * format specs are workspace-authored column metadata, not app config — a
 * wild value must degrade gracefully, never fail the build.
 */
const MAX_DECIMAL_PLACES = 100;

function readDecimalPlaces(obj: Record<string, unknown>): number | undefined {
  const dp = obj.decimal_places;
  if (typeof dp === "number" && Number.isFinite(dp) && dp >= 0) {
    return Math.min(Math.floor(dp), MAX_DECIMAL_PLACES);
  }
  if (dp && typeof dp === "object" && !Array.isArray(dp)) {
    const places = (dp as Record<string, unknown>).places;
    if (typeof places === "number" && Number.isFinite(places) && places >= 0) {
      return Math.min(Math.floor(places), MAX_DECIMAL_PLACES);
    }
  }
  return undefined;
}

/**
 * Map ISO currency codes to their conventional prefix symbol. Unknown codes
 * fall back to the literal code + space (e.g., "AUD #,##0.00") so the value
 * is never lost — `formatValue` and `toD3Format` will still render correctly,
 * just without a single-character glyph.
 */
function currencySymbol(code: string): string {
  switch (code) {
    case "USD":
      return "$";
    case "EUR":
      return "€";
    case "GBP":
      return "£";
    case "JPY":
    case "CNY":
      return "¥";
    case "INR":
      return "₹";
    case "BRL":
      return "R$";
    default:
      return `${code} `;
  }
}

/**
 * Infer the standard set of valid time grains for a dimension based on its
 * SQL data type.
 *
 *   TIMESTAMP / TIMESTAMP_LTZ / TIMESTAMP_NTZ → all 7 standard grains
 *   DATE → [day, week, month, quarter, year] (no sub-day grains)
 *   anything else → undefined (not time-typed)
 *
 * Earlier code looked for a `time_grain` attribute on the YAML column. That
 * field does not exist in the UC metric-view schema (see the v11 Rust serde
 * — Column has 7 known properties: window, expr, format, display_name,
 * name, comment, synonyms; CREATE fails with "Unrecognized field
 * 'time_grain'"). So grain qualification has to come from the column's
 * resolved SQL type instead.
 */
function inferTimeGrains(type: string): string[] | undefined {
  // Strip parameterized suffixes ("TIMESTAMP(6)" → "TIMESTAMP") and trim.
  const normalized = type
    .toLowerCase()
    .replace(/\(.*\)$/, "")
    .trim();
  if (
    normalized === "timestamp" ||
    normalized === "timestamp_ltz" ||
    normalized === "timestamp_ntz"
  ) {
    return ["day", "hour", "minute", "month", "quarter", "week", "year"];
  }
  if (normalized === "date") {
    return ["day", "month", "quarter", "week", "year"];
  }
  return undefined;
}

/**
 * Map a Databricks SQL type to a TypeScript primitive.
 * Centralized here (not imported from query-registry) so this module
 * stays self-contained at Phase 1.
 */
function tsTypeFor(sqlType: string): string {
  const normalized = sqlType
    .toUpperCase()
    .replace(/\(.*\)$/, "")
    .replace(/<.*>$/, "")
    .split(" ")[0];

  switch (normalized) {
    case "BOOLEAN":
      return "boolean";
    case "TINYINT":
    case "SMALLINT":
    case "INT":
    case "INTEGER":
    case "BIGINT":
    case "FLOAT":
    case "DOUBLE":
    case "DECIMAL":
    case "NUMERIC":
      return "number";
    default:
      return "string";
  }
}

/**
 * Render a MetricRegistry interface entry from a MetricSchema.
 *
 * Degraded schemas (see {@link MetricSchema.degraded}) render permissive
 * types instead of exact unions: the schema is unknown, so `never`-style
 * empty unions would reject every measure/dimension/grain and block the app
 * from compiling until the warehouse comes back. Non-degraded schemas —
 * including genuinely column-light views — keep accurate unions.
 */
function renderMetricEntry(schema: MetricSchema): string {
  if (schema.degraded) {
    return renderDegradedMetricEntry(schema);
  }
  const indent = "      ";
  const measures =
    schema.measures.length > 0
      ? schema.measures
          .map(
            (m) => `${indent}/** @sqlType ${m.type} */
${indent}${JSON.stringify(m.name)}: ${tsTypeFor(m.type)}`,
          )
          .join(";\n")
      : "";
  const dimensions =
    schema.dimensions.length > 0
      ? schema.dimensions
          .map((d) => {
            const grainComment = d.timeGrains?.length
              ? ` @timeGrain ${d.timeGrains.join("|")}`
              : "";
            return `${indent}/** @sqlType ${d.type}${grainComment} */
${indent}${JSON.stringify(d.name)}: ${tsTypeFor(d.type)}`;
          })
          .join(";\n")
      : "";

  const measureKeys = schema.measures.map((m) => JSON.stringify(m.name));
  const dimensionKeys = schema.dimensions.map((d) => JSON.stringify(d.name));

  const measuresBlock = measures
    ? `{
${measures};
    }`
    : "Record<string, never>";

  const dimensionsBlock = dimensions
    ? `{
${dimensions};
    }`
    : "Record<string, never>";

  const measureUnion =
    measureKeys.length > 0 ? measureKeys.join(" | ") : "never";
  const dimensionUnion =
    dimensionKeys.length > 0 ? dimensionKeys.join(" | ") : "never";

  // Union of allowed time-grains across every time-typed dimension. The PRD
  // documents the v1 contract: a single top-level `timeGrain` applies to all
  // time-typed dims. Therefore the type-level constraint is the union (any of
  // the dim-allowed grains is acceptable; per-dim narrowing is a future
  // widening to `TimeGrain<K> | Record<DimensionKey<K>, TimeGrain<K>>`).
  const timeGrainSet = new Set<string>();
  for (const d of schema.dimensions) {
    for (const g of d.timeGrains ?? []) {
      timeGrainSet.add(g);
    }
  }
  const timeGrainUnion =
    timeGrainSet.size > 0
      ? [...timeGrainSet]
          .sort()
          .map((g) => JSON.stringify(g))
          .join(" | ")
      : "never";

  const measureMetadata = renderMetadataMap(schema.measures, indent);
  const dimensionMetadata = renderMetadataMap(schema.dimensions, indent, true);

  return `    ${JSON.stringify(schema.key)}: {
      key: ${JSON.stringify(schema.key)};
      source: ${JSON.stringify(schema.source)};
      lane: ${JSON.stringify(schema.lane)};
      measures: ${measuresBlock};
      dimensions: ${dimensionsBlock};
      measureKeys: ${measureUnion};
      dimensionKeys: ${dimensionUnion};
      timeGrains: ${timeGrainUnion};
      metadata: {
        measures: ${measureMetadata};
        dimensions: ${dimensionMetadata};
      };
    }`;
}

/**
 * Render the permissive ("degraded-open") entry for a schema the warehouse
 * could not describe. Key/source/lane stay exact (they come from
 * metric-views.json, not the warehouse); everything schema-derived opens up:
 *
 *   - `measureKeys` / `dimensionKeys` / `timeGrains` become `string` so any
 *     helper-type union derived from them accepts arbitrary identifiers;
 *   - `measures` / `dimensions` become `Record<string, unknown>` so the row
 *     type they feed is permissive instead of `Record<string, never>`;
 *   - `metadata` stays `Record<string, never>` — it mirrors the runtime
 *     bundle, which emits `{ measures: {}, dimensions: {} }` for this key.
 *
 * The next successful run (warehouse RUNNING) replaces this entry with exact
 * unions; a confirmed-empty view never takes this path.
 */
function renderDegradedMetricEntry(schema: MetricSchema): string {
  return `    /** Degraded: schema unavailable at type-generation time — permissive types until a successful DESCRIBE refreshes them. */
    ${JSON.stringify(schema.key)}: {
      key: ${JSON.stringify(schema.key)};
      source: ${JSON.stringify(schema.source)};
      lane: ${JSON.stringify(schema.lane)};
      measures: Record<string, unknown>;
      dimensions: Record<string, unknown>;
      measureKeys: string;
      dimensionKeys: string;
      timeGrains: string;
      metadata: {
        measures: Record<string, never>;
        dimensions: Record<string, never>;
      };
    }`;
}

/**
 * Render the type-level shape of a column's semantic-metadata map for the
 * `metadata` field of a MetricRegistry entry.
 *
 * The shape mirrors {@link MetricColumnSemanticMetadata}: each column emits an
 * object literal with `type` (string literal) plus optional `display_name`,
 * `format`, `description` (string literals when known, dropped when absent),
 * and — for dimensions only — `time_grain` (the column's allowed-grain tuple
 * literal).
 *
 * When the column list is empty, the type collapses to `Record<string, never>`
 * so consumers can still index into `metadata.measures` / `metadata.dimensions`
 * without TypeScript errors.
 */
function renderMetadataMap(
  cols: MetricColumnMetadata[],
  indent: string,
  includeTimeGrain = false,
): string {
  if (cols.length === 0) return "Record<string, never>";

  const inner = cols
    .map((col) => {
      const fields: string[] = [`type: ${JSON.stringify(col.type)}`];
      if (col.displayName) {
        fields.push(`display_name: ${JSON.stringify(col.displayName)}`);
      }
      if (col.format) {
        fields.push(`format: ${JSON.stringify(col.format)}`);
      }
      if (col.description) {
        fields.push(`description: ${JSON.stringify(col.description)}`);
      }
      if (includeTimeGrain && col.timeGrains && col.timeGrains.length > 0) {
        const grainTuple = col.timeGrains
          .map((g) => JSON.stringify(g))
          .join(", ");
        fields.push(`time_grain: readonly [${grainTuple}]`);
      }
      const fieldsBlock = fields.map((f) => `${indent}  ${f}`).join(";\n");
      return `${indent}${JSON.stringify(col.name)}: {
${fieldsBlock};
${indent}}`;
    })
    .join(";\n");

  return `{
${inner};
    }`;
}

/**
 * Render the augmentation block for the appkit-ui MetricRegistry interface.
 *
 * Mirrors the pattern in `generateTypeDeclarations` for QueryRegistry — emits
 * a `declare module` block that consumers in `@databricks/appkit-ui/react`
 * pick up via TypeScript module augmentation.
 */
function renderMetricRegistry(schemas: MetricSchema[]): string {
  if (schemas.length === 0) {
    return `declare module "@databricks/appkit-ui/react" {
  interface MetricRegistry {}
}
`;
  }
  const entries = schemas.map(renderMetricEntry).join(";\n");
  return `declare module "@databricks/appkit-ui/react" {
  interface MetricRegistry {
${entries};
  }
}
`;
}

/**
 * Default header for the generated metric.d.ts file. The file is consumed by
 * TypeScript via module augmentation only, so no runtime import is needed.
 */
function metricFileHeader(): string {
  return `// Auto-generated by AppKit - DO NOT EDIT
// Generated by 'npx @databricks/appkit generate-types' or Vite plugin during build
import "@databricks/appkit-ui/react";
`;
}

/**
 * Build the full metric.d.ts file from a list of metric schemas.
 */
export function generateMetricTypeDeclarations(
  schemas: MetricSchema[],
): string {
  return metricFileHeader() + renderMetricRegistry(schemas);
}

/**
 * Per-column metadata as emitted into the build-time JSON artifact.
 *
 * The shape is deliberately narrow — we forward what the YAML 1.1 declared
 * (type, display name, format spec, description) plus the time-grain list for
 * dimensions. Consumers (the React hook, the format utilities) destructure
 * only the fields they need; absent fields stay absent rather than carrying
 * empty-string sentinels so JSON.stringify output is minimal.
 *
 * Internal — exposed via the {@link buildMetricsMetadataBundle} return shape.
 * Library consumers see this shape mirrored verbatim in
 * `@databricks/appkit-ui/format`'s `ColumnMetadata` (they import there, not
 * here).
 */
interface MetricColumnSemanticMetadata {
  type: string;
  display_name?: string;
  format?: string;
  description?: string;
  /** Only emitted on dimension entries that resolved to a TIMESTAMP* or DATE SQL type (grain set inferred from type). */
  time_grain?: readonly string[];
}

/**
 * One metric's complete semantic-metadata bundle.
 *
 * Splits cleanly into measures + dimensions so the consuming hook can return
 * the exact subset for the queried metric without scanning the rest of the
 * registry.
 *
 * Server-side concerns — UC FQN (`source`) and execution lane (`lane`) — are
 * deliberately NOT part of this artifact. They live in metric-views.json and
 * are consumed by the server only. The bundle ships to the client in
 * `metrics.metadata.json` and must contain frontend-safe metadata only
 * (display names, format specs, descriptions, time-grain hints).
 */
interface MetricSemanticMetadataEntry {
  measures: Record<string, MetricColumnSemanticMetadata>;
  dimensions: Record<string, MetricColumnSemanticMetadata>;
}

/**
 * Top-level shape of `metrics.metadata.json` — keyed by metric key.
 *
 * Loaded by:
 *  - the server-side `loadMetricRegistry` (for body-validator awareness of
 *    display names + types in error messages, when wired up in a follow-on)
 *  - the client-side `useMetricView` hook (returned in the `metadata` field)
 *  - any chart-library glue code that wants direct access to format specs /
 *    display names (Plotly tickformat, ECharts valueFormatter, table cells, ...)
 */
type MetricsMetadataBundle = Record<string, MetricSemanticMetadataEntry>;

/**
 * Pure function: turn a list of metric schemas into the JSON metadata bundle.
 *
 * Deterministic key order: outer object keys are sorted in locale-independent
 * code-unit order (see {@link compareKeys} — identical to the .d.ts order);
 * measures and dimensions are emitted in the order they appeared in DESCRIBE
 * (Phase 1's preserved-from-YAML order), but each per-column object's fields
 * follow a fixed declaration order so snapshot diffs are stable.
 *
 * The output is `JSON.stringify`'d with two-space indentation by the file
 * emitter — keeping the data structure pure here lets unit tests assert on the
 * structure without parsing.
 */
export function buildMetricsMetadataBundle(
  schemas: MetricSchema[],
): MetricsMetadataBundle {
  // Null-prototype maps, same guard as the typegen cache section in
  // index.ts: metric keys are user-controlled config input and column names
  // are workspace-controlled DESCRIBE output — "__proto__" passes the metric
  // key regex and is a legal column name. On a plain object that write would
  // hit the Object.prototype setter (swapping the object's prototype and
  // silently dropping the entry from the emitted JSON) instead of storing
  // data.
  const bundle: MetricsMetadataBundle = Object.create(null);
  // compareKeys (code-unit), NOT localeCompare: the bundle's key order must
  // be byte-identical to the .d.ts entry order (resolveMetricConfig's sort)
  // on every machine and locale.
  const sortedSchemas = [...schemas].sort((a, b) => compareKeys(a.key, b.key));

  for (const schema of sortedSchemas) {
    const measures: Record<string, MetricColumnSemanticMetadata> =
      Object.create(null);
    for (const m of schema.measures) {
      measures[m.name] = buildColumnMetadata(m);
    }

    const dimensions: Record<string, MetricColumnSemanticMetadata> =
      Object.create(null);
    for (const d of schema.dimensions) {
      dimensions[d.name] = buildColumnMetadata(d);
    }

    bundle[schema.key] = {
      measures,
      dimensions,
    };
  }

  return bundle;
}

/**
 * Render one column's emitted semantic-metadata object.
 *
 * Field order is fixed (`type`, `display_name`, `format`, `description`,
 * `time_grain`) and absent fields are simply not included, so the snapshot
 * diff is always minimal — consumers receive only what the YAML declared.
 *
 * `time_grain` is only emitted on dimensions whose SQL type is TIMESTAMP* or
 * DATE — measures never receive a grain since they aren't grouped on. The
 * caller (extractMetricColumns) skips inference for `isMeasure: true` columns.
 */
function buildColumnMetadata(
  col: MetricColumnMetadata,
): MetricColumnSemanticMetadata {
  const entry: MetricColumnSemanticMetadata = { type: col.type };
  if (col.displayName) entry.display_name = col.displayName;
  if (col.format) entry.format = col.format;
  if (col.description) entry.description = col.description;
  if (!col.isMeasure && col.timeGrains && col.timeGrains.length > 0) {
    entry.time_grain = [...col.timeGrains];
  }
  return entry;
}

/**
 * Serialize the metadata bundle to a stable, human-readable JSON string.
 *
 * Uses two-space indentation and a trailing newline so file diffs are clean
 * across regenerations; the bundle's own key order is already sorted by
 * {@link buildMetricsMetadataBundle}.
 */
export function generateMetricsMetadataJson(schemas: MetricSchema[]): string {
  const bundle = buildMetricsMetadataBundle(schemas);
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/**
 * Optional dependency-injection seam: the function used to fetch DESCRIBE
 * results for a given FQN. Production wires this through the WorkspaceClient;
 * tests inject a mock that returns a representative DESCRIBE response.
 */
export type DescribeFetcher = (
  fqn: string,
) => Promise<DatabricksStatementExecutionResponse>;

/**
 * Build a DescribeFetcher from a real WorkspaceClient + warehouseId.
 *
 * The client is supplied by the caller rather than constructed here:
 * `generateFromEntryPoint` keeps at most ONE WorkspaceClient per generation
 * pass for the whole metric path (status probe, blocking preflight, and this
 * fetcher all share it). Type-only SDK import keeps this module free of the
 * SDK at test time.
 *
 * `wait_timeout: "30s"` makes the API wait synchronously for the statement
 * to complete (matching the SDK's own example pattern). Without an explicit
 * wait, the call can return while the statement is still PENDING/RUNNING —
 * the response carries no `data_array` yet, `parseDescribeTableExtendedJson`
 * reads that as "returned no rows", and the registry ships empty. The
 * runtime fail-closed gate then 503s every metric request, which is exactly
 * the symptom we hit on a cold warehouse.
 */
export function createWorkspaceDescribeFetcher(
  client: WorkspaceClient,
  warehouseId: string,
): DescribeFetcher {
  return async (fqn: string) => {
    // Defense-in-depth: every caller passes a source that already cleared
    // resolveMetricConfig, but this fetcher is an exported seam — re-check
    // before interpolating into SQL.
    if (!isValidFqn(fqn)) {
      throw new Error(
        `Invalid metric source "${fqn}": expected a three-part UC FQN <catalog>.<schema>.<metric_view>.`,
      );
    }
    // Backtick-quote each segment. The segment charset
    // ([a-zA-Z0-9_][a-zA-Z0-9_-]*, enforced by the regex above) cannot
    // contain backticks (or dots), so the quoting cannot be escaped from —
    // while the SQL metacharacter the charset DOES allow is neutralized
    // inside the quotes (a hyphenated segment like "c--x" would otherwise
    // open a `--` line comment mid-statement).
    const quotedFqn = fqn
      .split(".")
      .map((segment) => `\`${segment}\``)
      .join(".");
    const result = (await client.statementExecution.executeStatement({
      statement: `DESCRIBE TABLE EXTENDED ${quotedFqn} AS JSON`,
      warehouse_id: warehouseId,
      wait_timeout: "30s",
    })) as DatabricksStatementExecutionResponse;
    return result;
  };
}

/**
 * One per-entry sync failure recorded by {@link syncMetrics}. Failures are
 * surfaced to the caller (CLI / Vite plugin) so they can decide whether to
 * exit non-zero. Without this, a silently-empty bundle would ship to
 * production and the route's runtime fail-closed gate would 503 every
 * affected metric.
 */
export interface MetricSyncFailure {
  /** Stable metric key — matches the key under `metricViews` in metric-views.json. */
  key: string;
  /** Three-part FQN that failed to resolve. */
  source: string;
  /** Single human-readable reason (DESCRIBE failed, parse failed, zero columns). */
  reason: string;
  /**
   * Whether the failure is expected to self-converge on a later pass without
   * a config change. `true` for failures whose cause lives outside the
   * entry's definition — a rejected fetch (transport/auth blip) or an
   * unexplained settlement rejection — so retrying the same DESCRIBE can
   * succeed. `false` for deterministic warehouse answers (FAILED statement,
   * SUCCEEDED with zero rows, unparseable response, zero extracted columns):
   * re-describing an unchanged entry would fail identically, so the caller's
   * cache pins these sticky (`retry: false`) until the config (hash) changes
   * or the cache is bypassed. Additive field — existing fields are consumed
   * by the CLI via dynamic import and must not change shape.
   */
  transient: boolean;
}

/**
 * Result shape from {@link syncMetrics}: the schemas (one per entry, possibly
 * empty if the entry failed) plus a list of per-entry failures so the caller
 * can emit a non-zero exit / build error when something didn't resolve.
 */
export interface MetricSyncResult {
  schemas: MetricSchema[];
  failures: MetricSyncFailure[];
}

/**
 * Build the degraded schema emitted when an entry's columns are not
 * available — same key/source/lane as a real schema, with empty
 * measure/dimension allowlists and `degraded: true` (see
 * {@link MetricSchema.degraded}: the schema is unknown, so renderers emit
 * permissive types instead of `never`-style empty unions). Shared by
 * {@link syncMetrics}' per-entry failure + non-terminal paths and by callers
 * that skip DESCRIBE entirely (the non-blocking warehouse gate in
 * `generateFromEntryPoint`), so "entry present but unknown" has exactly one
 * definition.
 */
export function emptyMetricSchema(
  entry: Pick<MetricSchema, "key" | "source" | "lane">,
): MetricSchema {
  return {
    key: entry.key,
    source: entry.source,
    lane: entry.lane,
    measures: [],
    dimensions: [],
    degraded: true,
  };
}

/**
 * Maximum number of in-flight DESCRIBE statements per {@link syncMetrics}
 * pass. Mirrors the query path's (unexported) default `concurrency = 10` in
 * query-registry.ts (`generateQueriesFromDescribe`); kept as a separate
 * metric-local constant because the two describe pipelines are deliberately
 * split — queries and metric views may bind to different warehouses in the
 * future.
 */
const METRIC_DESCRIBE_CONCURRENCY = 10;

/**
 * Outcome of describing a single metric entry, tagged with the entry's
 * position in `resolution.entries` so chunked, out-of-order completion can
 * be reassembled into config order. `failure` is present only for genuine
 * failures (rejected fetch, FAILED statement, unparseable response, zero
 * columns) — a degraded-but-not-failed schema (non-terminal state) carries
 * no failure.
 */
interface MetricDescribeOutcome {
  index: number;
  schema: MetricSchema;
  failure?: MetricSyncFailure;
}

/**
 * Run schema synchronization for every entry in `metric-views.json`.
 *
 * `fetcher` is injected so the same code path serves Vite, the CLI, and unit
 * tests with a mock that returns a representative DESCRIBE response.
 *
 * Entries are described with bounded concurrency: chunks of
 * {@link METRIC_DESCRIBE_CONCURRENCY} run via `Promise.allSettled`, the next
 * chunk starting only after the previous one fully settles (the query path's
 * batching in query-registry). Results are placed by entry index, so
 * `schemas` (and `failures`) always come back in `resolution.entries` order
 * regardless of completion order.
 *
 * Returns `{ schemas, failures }`. The schemas array always carries one
 * entry per registered metric. Classification mirrors the query path
 * (query-registry's describe flow):
 *
 *  - FAILED statement, rejected fetch, unparseable response, or zero
 *    extracted columns → a genuine failure: recorded in `failures` AND the
 *    schema is `degraded: true` (its columns are unknown). Each failure also
 *    carries `transient` (see {@link MetricSyncFailure.transient}): rejected
 *    fetches are transient, deterministic warehouse answers are not.
 *  - Non-terminal statement state (PENDING/RUNNING — warehouse reachable but
 *    not ready) → degraded, never an error: schema is `degraded: true`, NOT
 *    in `failures`. The next run with a ready warehouse lands the real
 *    schema.
 *  - SUCCEEDED with extracted columns → real schema, `degraded` unset (a
 *    genuinely column-light view keeps its accurate empty unions).
 *
 * Callers (the CLI, the Vite plugin) inspect `failures` to decide whether to
 * exit non-zero; renderers inspect `degraded` to emit permissive types. The
 * two are orthogonal: failures drive loud reporting, degraded drives
 * permissive rendering.
 *
 * This function is deliberately log-free: callers own surfacing `failures`
 * (logging, exit codes) and degraded summaries, so each is reported exactly
 * once at the call site instead of once in here and again by the caller.
 */
export async function syncMetrics(
  resolution: MetricConfigResolution,
  fetcher: DescribeFetcher,
): Promise<MetricSyncResult> {
  const { entries } = resolution;
  // Index-keyed slots: every entry writes exactly one schema slot (and at
  // most one failure slot), so output order equals config order no matter
  // which DESCRIBE settles first.
  const schemas = new Array<MetricSchema>(entries.length);
  const failureSlots = new Array<MetricSyncFailure | undefined>(entries.length);

  const describeOne = async (
    entry: ResolvedMetricEntry,
    index: number,
  ): Promise<MetricDescribeOutcome> => {
    let response: DatabricksStatementExecutionResponse;
    try {
      response = await fetcher(entry.source);
    } catch (err) {
      // The fetcher itself threw — a transport/auth blip, not a warehouse
      // verdict on the entry. Transient: a later pass may succeed unchanged.
      const reason = `DESCRIBE TABLE EXTENDED failed: ${(err as Error).message}`;
      return {
        index,
        schema: emptyMetricSchema(entry),
        failure: {
          key: entry.key,
          source: entry.source,
          reason,
          transient: true,
        },
      };
    }

    // Non-terminal statement state (PENDING/RUNNING): the warehouse is
    // reachable but not ready — stopped or cold-starting, with the DESCRIBE's
    // `wait_timeout` elapsed before completion. Degraded, never an error
    // (precedent: query-registry treats anything that is neither FAILED nor
    // SUCCEEDED as "unavailable"). The response carries no rows yet, so
    // falling through would misclassify this as the "returned no rows" /
    // wrong-FQN failure.
    const state = response.status?.state;
    if (state !== "SUCCEEDED" && state !== "FAILED") {
      return { index, schema: emptyMetricSchema(entry) };
    }

    let columns: MetricColumnMetadata[] = [];
    let parseError: string | null = null;
    try {
      const parsed = parseDescribeTableExtendedJson(response);
      columns = extractMetricColumns(parsed);
    } catch (err) {
      parseError = `Failed to extract columns from DESCRIBE response: ${(err as Error).message}`;
    }

    if (parseError) {
      // Deterministic warehouse answer (FAILED statement, SUCCEEDED with zero
      // rows, unparseable payload): re-describing the same entry would fail
      // identically, so this failure is non-transient (sticky in the cache).
      return {
        index,
        schema: emptyMetricSchema(entry),
        failure: {
          key: entry.key,
          source: entry.source,
          reason: parseError,
          transient: false,
        },
      };
    }

    if (columns.length === 0) {
      // Extraction succeeded but yielded no columns. The most common cause
      // is a DESCRIBE response shape that `extractMetricColumns` doesn't
      // recognize. Treat as a failure so CI catches it instead of letting an
      // empty bundle entry ship — the route's fail-closed gate would then
      // 503 every request to this metric in production. The schema is also
      // degraded: its real columns are unknown.
      const reason =
        "DESCRIBE response yielded zero columns — check the response shape (top-level `columns` array or `schema.fields`).";
      return {
        index,
        schema: emptyMetricSchema(entry),
        // Deterministic answer for this entry — non-transient, like the
        // parse failures above.
        failure: {
          key: entry.key,
          source: entry.source,
          reason,
          transient: false,
        },
      };
    }

    const measures = columns.filter((c) => c.isMeasure);
    const dimensions = columns.filter((c) => !c.isMeasure);

    return {
      index,
      schema: {
        key: entry.key,
        source: entry.source,
        lane: entry.lane,
        measures,
        dimensions,
      },
    };
  };

  for (
    let offset = 0;
    offset < entries.length;
    offset += METRIC_DESCRIBE_CONCURRENCY
  ) {
    // The final slice is naturally partial: slice() clamps to entries.length.
    const slice = entries.slice(offset, offset + METRIC_DESCRIBE_CONCURRENCY);
    const settled = await Promise.allSettled(
      slice.map((entry, i) => describeOne(entry, offset + i)),
    );

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === "fulfilled") {
        const { index, schema, failure } = result.value;
        schemas[index] = schema;
        if (failure) {
          failureSlots[index] = failure;
        }
      } else {
        // describeOne catches every expected failure internally, so a
        // rejected settlement should be impossible — but handle it
        // defensively (the query path's processBatchResults does the same)
        // so one entry's surprise throw degrades only that entry, never its
        // siblings.
        const index = offset + i;
        const entry = entries[index];
        const message =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        schemas[index] = emptyMetricSchema(entry);
        // Unknown cause — prefer convergence: mark transient so the next
        // describe-capable pass retries instead of pinning a surprise.
        failureSlots[index] = {
          key: entry.key,
          source: entry.source,
          reason: `DESCRIBE TABLE EXTENDED failed: ${message}`,
          transient: true,
        };
      }
    }
  }

  // Compact the slots: failures come out ordered by entry index.
  const failures = failureSlots.filter(
    (failure): failure is MetricSyncFailure => failure !== undefined,
  );

  return { schemas, failures };
}
