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
 * We only need a small subset at Phase 1 (measure names + types). Dimensions
 * and YAML metadata land in later phases.
 */
export interface MetricColumnMetadata {
  name: string;
  type: string;
  /** UC marks columns produced by `MEASURE()` as measures; everything else is a dimension. */
  isMeasure: boolean;
  /** Optional column comment / display description (best-effort). */
  description?: string;
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

    columns.push({ name, type, isMeasure, description });
  }

  return columns;
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
          .map(
            (d) => `${indent}/** @sqlType ${d.type} */
${indent}${JSON.stringify(d.name)}: ${tsTypeFor(d.type)}`,
          )
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

  return `    ${JSON.stringify(schema.key)}: {
      key: ${JSON.stringify(schema.key)};
      source: ${JSON.stringify(schema.source)};
      lane: ${JSON.stringify(schema.lane)};
      measures: ${measuresBlock};
      dimensions: ${dimensionsBlock};
      measureKeys: ${measureUnion};
      dimensionKeys: ${dimensionUnion};
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
