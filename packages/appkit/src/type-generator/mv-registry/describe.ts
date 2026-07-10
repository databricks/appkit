// Grammar + SQL-quoting for metric-view FQNs live together in the shared,
// zod-free leaf so the type-generator and the analytics runtime validate and
// escape against one source of truth (see the module doc in metric-fqn.ts).
import {
  isValidFqn,
  quoteFqnForSql,
} from "../../../../shared/src/schemas/metric-fqn";
import type { WorkspaceClient } from "../../workspace-client";
import { type DescribeFormatMemo, describeAdaptive } from "../statement-result";
import type { DatabricksStatementExecutionResponse } from "../types";
import type { DescribeFetcher, MetricColumnMetadata } from "./types";

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
 * Tolerant of multiple JSON shapes (the field may be `columns` or
 * `schema.fields`, type may be a string or `{ name }` object, the measure
 * marker may be `is_measure` or under `metadata.is_measure`).
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
 * AS JSON into a printf-like format string.
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
 * Maximum decimal places honored from a format spec.
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
 * fall back to the literal code + space.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  INR: "₹",
  BRL: "R$",
};

function currencySymbol(code: string): string {
  return CURRENCY_SYMBOLS[code] ?? `${code} `;
}

/**
 * Infer the standard set of valid time grains for a dimension based on its
 * SQL data type.
 */
function inferTimeGrains(type: string): string[] | undefined {
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
 * Build a DescribeFetcher from a real WorkspaceClient + warehouseId.
 */
export function createWorkspaceDescribeFetcher(
  client: WorkspaceClient,
  warehouseId: string,
): DescribeFetcher {
  // One format probe per fetcher (= per typegen run): the first DESCRIBE
  // discovers the warehouse's working format, every later one reuses it.
  const describeFormat: DescribeFormatMemo = {};
  return async (fqn: string) => {
    /**
     * Defense-in-depth: every caller passes a source that already cleared
     * {@link resolveMetricConfig}, but this fetcher is an exported seam — re-check
     * before interpolating into SQL.
     */
    if (!isValidFqn(fqn)) {
      throw new Error(
        `Invalid metric source "${fqn}": expected a three-part UC FQN <catalog>.<schema>.<metric_view>.`,
      );
    }
    // Escape + quote every segment before interpolation. isValidFqn already
    // rejects backticks/control chars for metric sources, so this is
    // belt-and-suspenders for the SQL-injection seam — and keeps the quoting
    // independent of the naming rule.
    const quotedFqn = quoteFqnForSql(fqn);
    return describeAdaptive(
      client,
      `DESCRIBE TABLE EXTENDED ${quotedFqn} AS JSON`,
      warehouseId,
      describeFormat,
    );
  };
}
