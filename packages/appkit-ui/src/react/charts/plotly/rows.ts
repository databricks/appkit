import type { ChartData } from "../types";
import { isArrowTable } from "../types";

/** Plain JS row object (one record per data row). */
export type PlotlyRow = Record<string, unknown>;

/**
 * Converts chart data (Arrow Table or JSON array) into plain row objects so the
 * `traces` callback can map rows to arbitrary Plotly traces without caring about
 * the wire format. Kept free of any Plotly runtime imports so it can be used (and
 * tested) without loading the Plotly bundle.
 */
export function toRowObjects(data: ChartData): PlotlyRow[] {
  if (!isArrowTable(data)) {
    return Array.isArray(data) ? data : [];
  }
  const fields = data.schema.fields.map((f) => f.name);
  const rows: PlotlyRow[] = [];
  for (let i = 0; i < data.numRows; i++) {
    const row: PlotlyRow = {};
    for (const field of fields) {
      const value = data.getChild(field)?.get(i);
      // Arrow returns BigInt for 64-bit integers; coerce so Plotly can plot it.
      row[field] = typeof value === "bigint" ? Number(value) : value;
    }
    rows.push(row);
  }
  return rows;
}
