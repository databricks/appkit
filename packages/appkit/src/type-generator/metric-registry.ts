import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import { createLogger } from "../logging/logger";
import type { DatabricksStatementExecutionResponse } from "./types";

const logger = createLogger("type-generator:metric-registry");

/**
 * Default filename for the metric source declarations.
 * Lives at config/queries/metric.json by convention.
 */
const METRIC_CONFIG_FILE = "metric.json";

/**
 * The lane an entry sits in: `sp` (service principal, shared cache)
 * or `obo` (on-behalf-of, per-user cache).
 */
export type MetricLane = "sp" | "obo";

/**
 * Single entry in metric.json.
 *
 * v1 only allows `source`. Object form (rather than bare string) is the
 * forward-compat seam for future per-entry options (cacheTtl, defaultFilter, ...).
 */
interface MetricEntryConfig {
  source: string;
}

/**
 * Shape of metric.json (matches MetricSourceConfiguration generated from the JSON Schema).
 * Inlined here so the type-generator does not pull in the shared schema package at runtime.
 */
interface MetricSourceConfig {
  $schema?: string;
  sp?: Record<string, MetricEntryConfig>;
  obo?: Record<string, MetricEntryConfig>;
}

/**
 * Resolved entry consumed by the rest of the metric-view pipeline.
 * Lane is denormalized onto the entry so downstream code does not have to
 * track which top-level key it came from.
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
  /** Stable metric key (the map key in metric.json). */
  key: string;
  /** Three-part FQN of the metric view. */
  source: string;
  /** Execution lane this metric was registered under. */
  lane: MetricLane;
  /** Measure columns (those exposed by MEASURE()). */
  measures: MetricColumnMetadata[];
  /** Dimension columns (everything that is not a measure). */
  dimensions: MetricColumnMetadata[];
}

/**
 * Result of reading and resolving metric.json — split by lane plus a flat
 * list with lane denormalized for iteration.
 */
interface MetricConfigResolution {
  entries: ResolvedMetricEntry[];
}

/**
 * Read metric.json from a queries folder.
 *
 * Returns `null` if the file does not exist (the metric-view path is
 * additive — apps without metric.json must not be penalized).
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
      `Failed to parse metric.json at ${metricPath}: ${(err as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Invalid metric.json at ${metricPath}: expected an object with sp/obo keys.`,
    );
  }

  return parsed as MetricSourceConfig;
}

/**
 * Validate a key against the JSON Schema's metricKey pattern. Phase 1 keeps
 * this lightweight — the JSON Schema is the canonical contract for IDE/CI.
 */
function isValidMetricKey(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}

/**
 * Validate a UC FQN against the JSON Schema's source pattern.
 */
function isValidFqn(fqn: string): boolean {
  return /^[a-zA-Z0-9_][a-zA-Z0-9_-]*\.[a-zA-Z0-9_][a-zA-Z0-9_-]*\.[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(
    fqn,
  );
}

/**
 * Flatten the sp/obo map into a single list of resolved entries.
 *
 * Throws on duplicate keys across lanes (the same key cannot live in both),
 * invalid keys, or invalid FQNs. Stable ordering: sp lane first, alphabetical.
 */
export function resolveMetricConfig(
  config: MetricSourceConfig,
): MetricConfigResolution {
  const entries: ResolvedMetricEntry[] = [];
  const seen = new Set<string>();

  const lanes: Array<[MetricLane, Record<string, MetricEntryConfig>]> = [
    ["sp", config.sp ?? {}],
    ["obo", config.obo ?? {}],
  ];

  for (const [lane, laneMap] of lanes) {
    const sortedKeys = Object.keys(laneMap).sort();
    for (const key of sortedKeys) {
      if (!isValidMetricKey(key)) {
        throw new Error(
          `Invalid metric key "${key}" in lane "${lane}": must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
        );
      }

      if (seen.has(key)) {
        throw new Error(
          `Duplicate metric key "${key}": cannot appear in both sp and obo lanes.`,
        );
      }
      seen.add(key);

      const entry = laneMap[key];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
          `Invalid metric entry "${key}" in lane "${lane}": expected an object with a 'source' field.`,
        );
      }

      // v1 explicitly rejects unknown fields so future additions cannot be
      // silently consumed today.
      const allowed = new Set(["source"]);
      for (const field of Object.keys(entry)) {
        if (!allowed.has(field)) {
          throw new Error(
            `Invalid field "${field}" on metric entry "${key}": only 'source' is allowed at v1.`,
          );
        }
      }

      if (typeof entry.source !== "string" || entry.source.trim() === "") {
        throw new Error(
          `Invalid metric entry "${key}" in lane "${lane}": 'source' must be a non-empty string.`,
        );
      }

      if (!isValidFqn(entry.source)) {
        throw new Error(
          `Invalid metric source "${entry.source}" for "${key}": expected a three-part UC FQN <catalog>.<schema>.<metric_view>.`,
        );
      }

      entries.push({ key, source: entry.source, lane });
    }
  }

  return { entries };
}

/**
 * Parse the JSON payload returned by DESCRIBE TABLE EXTENDED ... AS JSON.
 *
 * The Statement Execution API returns a single string cell — this normalizer
 * unwraps it. Handles both the production (real warehouse) shape and the
 * shape produced by mocked test responses.
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
    const format = extractStringFromAny(obj, ["format", "format_spec"]);

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
 */
function renderMetricEntry(schema: MetricSchema): string {
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
 */
interface MetricSemanticMetadataEntry {
  source: string;
  lane: MetricLane;
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
 * Deterministic key order: outer object keys are sorted alphabetically;
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
  const bundle: MetricsMetadataBundle = {};
  const sortedSchemas = [...schemas].sort((a, b) => a.key.localeCompare(b.key));

  for (const schema of sortedSchemas) {
    const measures: Record<string, MetricColumnSemanticMetadata> = {};
    for (const m of schema.measures) {
      measures[m.name] = buildColumnMetadata(m);
    }

    const dimensions: Record<string, MetricColumnSemanticMetadata> = {};
    for (const d of schema.dimensions) {
      dimensions[d.name] = buildColumnMetadata(d);
    }

    bundle[schema.key] = {
      source: schema.source,
      lane: schema.lane,
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
 * Kept narrow so it does not require importing the SDK at test time.
 */
export function createWorkspaceDescribeFetcher(
  warehouseId: string,
): DescribeFetcher {
  const client = new WorkspaceClient({});
  return async (fqn: string) => {
    const result = (await client.statementExecution.executeStatement({
      statement: `DESCRIBE TABLE EXTENDED ${fqn} AS JSON`,
      warehouse_id: warehouseId,
    })) as DatabricksStatementExecutionResponse;
    return result;
  };
}

/**
 * Run schema synchronization for every entry in `metric.json`.
 *
 * `fetcher` is injected so the same code path serves Vite, the (Phase 6) CLI,
 * and unit tests with a mock that returns a representative DESCRIBE response.
 */
export async function syncMetrics(
  resolution: MetricConfigResolution,
  fetcher: DescribeFetcher,
): Promise<MetricSchema[]> {
  const schemas: MetricSchema[] = [];

  for (const entry of resolution.entries) {
    let response: DatabricksStatementExecutionResponse;
    try {
      response = await fetcher(entry.source);
    } catch (err) {
      logger.warn(
        "DESCRIBE TABLE EXTENDED failed for %s: %s",
        entry.source,
        (err as Error).message,
      );
      schemas.push({
        key: entry.key,
        source: entry.source,
        lane: entry.lane,
        measures: [],
        dimensions: [],
      });
      continue;
    }

    let columns: MetricColumnMetadata[] = [];
    try {
      const parsed = parseDescribeTableExtendedJson(response);
      columns = extractMetricColumns(parsed);
    } catch (err) {
      logger.warn(
        "Failed to extract columns from DESCRIBE response for %s: %s",
        entry.source,
        (err as Error).message,
      );
    }

    const measures = columns.filter((c) => c.isMeasure);
    const dimensions = columns.filter((c) => !c.isMeasure);

    schemas.push({
      key: entry.key,
      source: entry.source,
      lane: entry.lane,
      measures,
      dimensions,
    });
  }

  return schemas;
}
