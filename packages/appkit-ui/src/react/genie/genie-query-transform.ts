/**
 * Converts Genie's statement_response data into a flat record array
 * suitable for charting.
 *
 * The Genie API returns `{ manifest.schema.columns, result.data_array }`
 * where each column carries a SQL `type_name`. This module parses values
 * according to those types so downstream chart code receives proper
 * numbers and strings.
 */

import type { GenieStatementResponse } from "shared";

// SQL type_name values that map to numeric JS values
const NUMERIC_SQL_TYPES = new Set([
  "DECIMAL",
  "INT",
  "INTEGER",
  "BIGINT",
  "LONG",
  "SMALLINT",
  "TINYINT",
  "FLOAT",
  "DOUBLE",
  "SHORT",
  "BYTE",
]);

// SQL type_name values that map to date/timestamp strings
const DATE_SQL_TYPES = new Set(["DATE", "TIMESTAMP", "TIMESTAMP_NTZ"]);

export type ColumnCategory = "numeric" | "date" | "string";

export interface GenieColumnMeta {
  name: string;
  typeName: string;
  category: ColumnCategory;
}

export interface TransformedGenieData {
  rows: Record<string, unknown>[];
  columns: GenieColumnMeta[];
}

/**
 * Classify a SQL type_name into a high-level category.
 */
export function classifySqlType(typeName: string): ColumnCategory {
  const upper = typeName.toUpperCase();
  if (NUMERIC_SQL_TYPES.has(upper)) return "numeric";
  if (DATE_SQL_TYPES.has(upper)) return "date";
  return "string";
}

/**
 * Parse a single cell value based on its column category.
 */
function parseValue(raw: string | null, category: ColumnCategory): unknown {
  if (raw == null) return null;
  if (category === "numeric") {
    const n = Number(raw);
    return Number.isNaN(n) ? null : n;
  }
  // Dates and strings stay as strings — normalizeChartData detects ISO dates
  return raw;
}

/**
 * Transform a Genie statement_response into chart-ready rows + column metadata.
 *
 * Expects `data` to have the shape:
 * ```
 * {
 *   manifest: { schema: { columns: [{ name, type_name }, ...] } },
 *   result: { data_array: [["val", ...], ...] }
 * }
 * ```
 *
 * Returns `null` when the data is empty or malformed.
 */
export function transformGenieData(
  data: GenieStatementResponse | null | undefined,
): TransformedGenieData | null {
  if (!data) return null;

  const rawColumns = data.manifest?.schema?.columns;
  if (!rawColumns || rawColumns.length === 0) {
    return null;
  }

  const dataArray = data.result?.data_array;
  if (!dataArray || dataArray.length === 0) {
    return null;
  }

  const columns: GenieColumnMeta[] = rawColumns.map((col) => ({
    name: col.name,
    typeName: col.type_name,
    category: classifySqlType(col.type_name),
  }));

  const rows: Record<string, unknown>[] = dataArray.map((row) => {
    const record: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      record[col.name] = parseValue(row[i] ?? null, col.category);
    }
    return record;
  });

  return { rows, columns };
}
