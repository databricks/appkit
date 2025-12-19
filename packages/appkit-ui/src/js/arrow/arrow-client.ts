import type { Field, Table } from "apache-arrow";
import {
  DATE_FIELD_PATTERNS,
  METADATA_DATE_PATTERNS,
  NAME_FIELD_PATTERNS,
} from "../constants";
import {
  getArrowModule,
  initializeTypeIdSets,
  getTypeIdSets,
  getDecimalTypeId,
} from "./lazy-arrow";

// Re-export for backward compatibility
export { DATE_FIELD_PATTERNS, NAME_FIELD_PATTERNS };

// Re-export Table type for consumers
export type { Table, Field };

export class ArrowClient {
  /**
   * Processes an Arrow IPC buffer into a Table.
   * Lazily loads the Apache Arrow library on first use.
   *
   * @param buffer - The Arrow IPC format buffer
   * @returns Promise resolving to an Arrow Table
   */
  static async processArrowBuffer(buffer: Uint8Array): Promise<Table> {
    try {
      const arrow = await getArrowModule();
      // Initialize type ID sets now that Arrow is loaded
      await initializeTypeIdSets();
      return arrow.tableFromIPC(buffer);
    } catch (error) {
      throw new Error(
        `Failed to process Arrow buffer: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  static async fetchAndProcessArrow(
    url: string,
    headers?: Record<string, string>,
  ): Promise<Table> {
    try {
      const buffer = await ArrowClient.fetchArrow(url, headers);

      return ArrowClient.processArrowBuffer(buffer);
    } catch (error) {
      throw new Error(
        `Failed to fetch Arrow data: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  static extractArrowFields(table: Table) {
    return table.schema.fields.map((field: Field) => {
      return {
        name: field.name,
        type: field.type,
      };
    });
  }

  static extractArrowColumns(table: Table): Record<string, any> {
    const cols: Record<string, any> = {};

    for (const field of table.schema.fields) {
      const child = table.getChild(field.name);

      if (child) {
        cols[field.name] = child.toArray();
      }
    }

    return cols;
  }

  /**
   * Extracts chart data from Arrow table.
   * Uses get(i) to properly handle complex types like Decimal128.
   * Applies decimal scaling for DECIMAL types.
   *
   * Note: This method assumes Arrow has been loaded (via processArrowBuffer).
   *
   * @returns xData for axis, yDataMap for series data
   */
  static extractChartData(table: Table, xKey: string, yKeys: string[]) {
    // Early exit for empty tables - return cached empty object
    if (table.numRows === 0) {
      return EMPTY_RESULT;
    }

    // Get the Decimal type ID (Arrow must be loaded to have a Table)
    const decimalType = getDecimalTypeId();

    // Build a map of field name -> pre-computed divisor (10^scale) for decimal types
    const decimalDivisors = new Map<string, number>();
    for (const field of table.schema.fields) {
      if (field.typeId === decimalType) {
        const decType = field.type as { scale: number };
        if (typeof decType.scale === "number") {
          // Pre-compute divisor once per field instead of per-column call
          decimalDivisors.set(field.name, 10 ** decType.scale);
        }
      }
    }

    // Extract X column using proper value extraction
    const xCol = table.getChild(xKey);
    const xData = extractColumnValues(xCol, decimalDivisors.get(xKey));

    // Extract Y columns using proper value extraction
    const yDataMap: Record<string, (string | number)[]> = {};
    for (let i = 0; i < yKeys.length; i++) {
      const key = yKeys[i];
      const col = table.getChild(key);
      yDataMap[key] = extractColumnValues(col, decimalDivisors.get(key));
    }

    return { xData, yDataMap };
  }

  /**
   * Automatically detect which fields to use for chart axes from an Arrow table
   * Uses the schema's type information for accurate field detection
   *
   * Note: This method assumes Arrow has been loaded (via processArrowBuffer).
   *
   * @param table - Arrow Table to analyze
   * @param orientation - Chart orientation ("vertical" for time-series, "horizontal" for categorical)
   * @returns Object containing the detected fields
   * @example
   * // Time-series data
   * detectFieldsFromArrow(timeSeriesTable)
   * // { xField: "date", yFields: ["revenue", "cost"], chartType: "timeseries" }
   *
   * // Categorical data
   * detectFieldsFromArrow(categoricalTable)
   * // { xField: "app_name", yFields: ["totalSpend"], chartType: "categorical" }
   */
  static detectFieldsFromArrow(
    table: Table,
    orientation?: "vertical" | "horizontal",
  ): DetectedFields & { chartType: "timeseries" | "categorical" } {
    const fields = table.schema.fields;

    if (fields.length === 0) {
      return { xField: "x", yFields: ["y"], chartType: "categorical" };
    }

    const fieldNames = fields.map((f) => f.name);

    // Get type ID sets (Arrow must be loaded to have a Table)
    const typeIdSets = getTypeIdSets();

    // Categorize fields by their Arrow type
    const temporalFields: string[] = [];
    const numericFields: string[] = [];
    const stringFields: string[] = [];

    for (const field of fields) {
      const typeId = field.typeId;

      if (typeIdSets.temporal.has(typeId)) {
        temporalFields.push(field.name);
      } else if (typeIdSets.numeric.has(typeId)) {
        numericFields.push(field.name);
      } else if (typeIdSets.string.has(typeId)) {
        stringFields.push(field.name);
      }
    }

    // Detect name/category fields: string fields matching name patterns
    let nameFields = stringFields.filter((name) =>
      NAME_FIELD_PATTERNS.some((pattern) =>
        name.toLowerCase().includes(pattern),
      ),
    );

    // Fallback: use any string field that doesn't end with _id
    if (nameFields.length === 0) {
      nameFields = stringFields.filter(
        (name) => !name.toLowerCase().endsWith("_id"),
      );
    }

    // Separate temporal fields into "chart-worthy" dates vs metadata dates
    const chartDateFields = temporalFields.filter(
      (name) =>
        !METADATA_DATE_PATTERNS.some((pattern) =>
          name.toLowerCase().includes(pattern),
        ),
    );
    const metadataDateFields = temporalFields.filter((name) =>
      METADATA_DATE_PATTERNS.some((pattern) =>
        name.toLowerCase().includes(pattern),
      ),
    );

    // Also check string fields for date patterns (but not metadata patterns)
    const stringDateFields = stringFields.filter(
      (name) =>
        DATE_FIELD_PATTERNS.some((pattern) =>
          name.toLowerCase().includes(pattern),
        ) &&
        !METADATA_DATE_PATTERNS.some((pattern) =>
          name.toLowerCase().includes(pattern),
        ),
    );

    const primaryDateFields = [...chartDateFields, ...stringDateFields];

    // Determine chart type: if we have good date fields for charting, it's time-series
    // If we only have metadata dates (like createdAt) and name fields, it's categorical
    const isTimeSeries =
      primaryDateFields.length > 0 && orientation !== "horizontal";
    const isCategorical =
      nameFields.length > 0 &&
      (primaryDateFields.length === 0 || orientation === "horizontal");

    if (orientation === "horizontal" || isCategorical) {
      // Categorical: x is name/category field, y is numeric field
      const xField =
        nameFields[0] ||
        primaryDateFields[0] ||
        metadataDateFields[0] ||
        fieldNames[0];
      const yFields =
        numericFields.length > 0
          ? numericFields
          : fieldNames.filter((k) => k !== xField);
      return { xField, yFields, chartType: "categorical" };
    }

    // Time-series (default): x is date/time field, y is numeric field
    const xField =
      primaryDateFields[0] ||
      metadataDateFields[0] ||
      nameFields[0] ||
      fieldNames[0];
    const yFields =
      numericFields.length > 0
        ? numericFields
        : fieldNames.filter((k) => k !== xField);
    return {
      xField,
      yFields,
      chartType: isTimeSeries ? "timeseries" : "categorical",
    };
  }

  static async fetchArrow(
    url: string,
    headers?: Record<string, string>,
  ): Promise<Uint8Array> {
    try {
      const response = await fetch(url, {
        headers: { "Content-Type": "application/octet-stream", ...headers },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();

      return new Uint8Array(buffer);
    } catch (error) {
      throw new Error(
        `Failed to fetch Arrow data: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }
}

export interface DetectedFields {
  /** X field */
  xField: string;
  /** Y fields */
  yFields: string[];
}

// ============================================================================
// Utility Functions
// ============================================================================

// Cached empty result to avoid allocations
const EMPTY_RESULT: {
  xData: (string | number)[];
  yDataMap: Record<string, (string | number)[]>;
} = {
  xData: [],
  yDataMap: {},
};

/**
 * Extracts values from an Arrow Vector properly.
 * Uses get(i) to handle complex types like Decimal128 correctly.
 * toArray() doesn't work properly for Decimal types - it returns raw bytes.
 *
 * @param col - The Arrow column/vector
 * @param divisor - Pre-computed divisor for DECIMAL types (10^scale)
 */
function extractColumnValues(
  col: { length: number; get: (i: number) => unknown } | null | undefined,
  divisor?: number,
): (string | number)[] {
  if (!col) return [];

  // Pre-allocate array for better performance with large datasets
  const len = col.length;
  const result: (string | number)[] = new Array(len);

  for (let i = 0; i < len; i++) {
    const val = col.get(i);
    if (val === null || val === undefined) {
      result[i] = 0;
    } else if (typeof val === "bigint") {
      // Apply decimal scaling if needed
      const num = Number(val);
      result[i] = divisor !== undefined ? num / divisor : num;
    } else if (typeof val === "number") {
      // Apply decimal scaling if needed
      result[i] = divisor !== undefined ? val / divisor : val;
    } else if (typeof val === "string") {
      result[i] = val;
    } else {
      // For complex types (like Decimal), try to convert to number
      const num = Number(val);
      result[i] = divisor !== undefined ? num / divisor : num;
    }
  }
  return result;
}
