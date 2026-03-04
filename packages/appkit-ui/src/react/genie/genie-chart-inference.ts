/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                    CHART INFERENCE RULES                           │
 * │                                                                     │
 * │  These rules determine what chart type is shown for Genie query    │
 * │  results. Modify thresholds and chart type mappings here.          │
 * │                                                                     │
 * │  Column types are classified from SQL type_name:                   │
 * │    DATE: DATE, TIMESTAMP, TIMESTAMP_NTZ                            │
 * │    NUMERIC: DECIMAL, INT, DOUBLE, FLOAT, LONG, etc.               │
 * │    STRING: STRING, VARCHAR, CHAR                                   │
 * │                                                                     │
 * │  Rules (applied in priority order):                                │
 * │                                                                     │
 * │  SKIP (return null):                                               │
 * │    - < 2 rows                                                      │
 * │    - < 2 columns                                                   │
 * │    - No numeric columns                                            │
 * │                                                                     │
 * │  MATCH:                                                            │
 * │    1. DATE + numeric(s)             → line (timeseries)            │
 * │    2. STRING + 1 numeric, ≤7 cats   → pie                         │
 * │    3. STRING + 1 numeric, ≤100 cats → bar                         │
 * │    4. STRING + 1 numeric, >100 cats → line                        │
 * │    5. STRING + N numerics, ≤50 cats → bar (grouped)               │
 * │    6. STRING + N numerics, >50 cats → line (multi-series)         │
 * │    7. 2+ numerics only              → scatter                     │
 * │    8. Otherwise                     → null (skip)                  │
 * │                                                                     │
 * │  KNOWN LIMITATIONS:                                                │
 * │    - First-column heuristic: picks first string col as category    │
 * │    - No semantic understanding (can't tell ID from meaningful val) │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import type { ChartType } from "../charts/types";
import type { GenieColumnMeta } from "./genie-query-transform";

// ---------------------------------------------------------------------------
// Configuration — edit thresholds here
// ---------------------------------------------------------------------------

const INFERENCE_CONFIG = {
  /** Min rows required to show any chart */
  minRows: 2,
  /** Max unique categories for pie chart */
  pieMaxCategories: 7,
  /** Max unique categories for bar chart (single series) */
  barMaxCategories: 100,
  /** Max unique categories for grouped bar chart (multi series) */
  groupedBarMaxCategories: 50,
} as const;

export interface ChartInference {
  chartType: ChartType;
  xKey: string;
  yKey: string | string[];
}

function countUnique(rows: Record<string, unknown>[], key: string): number {
  const seen = new Set<unknown>();
  for (const row of rows) {
    seen.add(row[key]);
  }
  return seen.size;
}

function hasNegativeValues(
  rows: Record<string, unknown>[],
  key: string,
): boolean {
  for (const row of rows) {
    if (Number(row[key]) < 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main inference function
// ---------------------------------------------------------------------------

/**
 * Infer the best chart type for the given Genie query result.
 * Returns `null` when the data is not suitable for charting.
 */
export function inferChartType(
  rows: Record<string, unknown>[],
  columns: GenieColumnMeta[],
): ChartInference | null {
  // Guard: need at least minRows and 2 columns
  if (rows.length < INFERENCE_CONFIG.minRows || columns.length < 2) {
    return null;
  }

  const dateCols = columns.filter((c) => c.category === "date");
  const numericCols = columns.filter((c) => c.category === "numeric");
  const stringCols = columns.filter((c) => c.category === "string");

  // Guard: must have at least one numeric column
  if (numericCols.length === 0) return null;

  // Rule 1: DATE + numeric(s) → line (timeseries)
  if (dateCols.length > 0 && numericCols.length >= 1) {
    return {
      chartType: "line",
      xKey: dateCols[0].name,
      yKey:
        numericCols.length === 1
          ? numericCols[0].name
          : numericCols.map((c) => c.name),
    };
  }

  // Rules 2–6: STRING + numeric(s)
  if (stringCols.length > 0 && numericCols.length >= 1) {
    const xKey = stringCols[0].name;
    const uniqueCategories = countUnique(rows, xKey);

    if (numericCols.length === 1) {
      const yKey = numericCols[0].name;

      // Rule 2: few categories → pie (skip if negative values)
      if (
        uniqueCategories <= INFERENCE_CONFIG.pieMaxCategories &&
        !hasNegativeValues(rows, yKey)
      ) {
        return { chartType: "pie", xKey, yKey };
      }
      // Rule 3: moderate categories → bar
      if (uniqueCategories <= INFERENCE_CONFIG.barMaxCategories) {
        return { chartType: "bar", xKey, yKey };
      }
      // Rule 4: many categories → line
      return { chartType: "line", xKey, yKey };
    }

    // Multiple numerics
    const yKey = numericCols.map((c) => c.name);

    // Rule 5: moderate categories → bar (grouped)
    if (uniqueCategories <= INFERENCE_CONFIG.groupedBarMaxCategories) {
      return { chartType: "bar", xKey, yKey };
    }
    // Rule 6: many categories → line (multi-series)
    return { chartType: "line", xKey, yKey };
  }

  // Rule 7: 2+ numerics only (no string, no date) → scatter
  if (
    numericCols.length >= 2 &&
    stringCols.length === 0 &&
    dateCols.length === 0
  ) {
    return {
      chartType: "scatter",
      xKey: numericCols[0].name,
      yKey: numericCols[1].name,
    };
  }

  // Rule 8: fallback — no chart
  return null;
}
