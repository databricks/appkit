import type { Table } from "apache-arrow";
import { useMemo } from "react";
import type { ChartData, DataFormat } from "../charts/types";
import { useAnalyticsQuery } from "./use-analytics-query";

/** Threshold for auto-selecting Arrow format (row count hint) */
const ARROW_THRESHOLD = 500;

// ============================================================================
// Hook Options & Result Types
// ============================================================================

export interface UseChartDataOptions {
  /** Analytics query key */
  queryKey: string;
  /** Query parameters */
  parameters?: Record<string, unknown>;
  /**
   * Data format preference
   * - "json": Force JSON format
   * - "arrow": Force Arrow format
   * - "auto": Auto-select based on heuristics
   * @default "auto"
   */
  format?: DataFormat;
  /** Transform data after fetching */
  transformer?: <T>(data: T) => T;
}

export interface UseChartDataResult {
  /** The fetched data (Arrow Table or JSON array) */
  data: ChartData | null;
  /** Whether the data is in Arrow format */
  isArrow: boolean;
  /** Loading state */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Whether the data is empty */
  isEmpty: boolean;
}

// ============================================================================
// Format Resolution
// ============================================================================

/**
 * Resolves the data format based on hints and preferences
 */
function resolveFormat(
  format: DataFormat,
  parameters?: Record<string, unknown>,
): "JSON" | "ARROW" {
  // Explicit format selection
  if (format === "json") return "JSON";
  if (format === "arrow") return "ARROW";

  // Auto-selection heuristics
  if (format === "auto") {
    // Check for explicit hint in parameters
    if (parameters?._preferArrow === true) return "ARROW";
    if (parameters?._preferJson === true) return "JSON";

    // Check limit parameter as data size hint
    const limit = parameters?.limit;
    if (typeof limit === "number" && limit > ARROW_THRESHOLD) {
      return "ARROW";
    }

    // Check for date range queries (often large)
    if (parameters?.startDate && parameters?.endDate) {
      return "ARROW";
    }

    return "JSON";
  }

  return "JSON";
}

// ============================================================================
// Main Hook
// ============================================================================

/**
 * Hook for fetching chart data in either JSON or Arrow format.
 * Automatically selects the best format based on query hints.
 *
 * @example
 * ```tsx
 * // Auto-select format
 * const { data, isArrow, loading } = useChartData({
 *   queryKey: "spend_data",
 *   parameters: { limit: 1000 }
 * });
 *
 * // Force Arrow format
 * const { data } = useChartData({
 *   queryKey: "big_query",
 *   format: "arrow"
 * });
 * ```
 */
export function useChartData(options: UseChartDataOptions): UseChartDataResult {
  const { queryKey, parameters, format = "auto", transformer } = options;

  // Resolve the format to use
  const resolvedFormat = useMemo(
    () => resolveFormat(format, parameters),
    [format, parameters],
  );

  const isArrowFormat = resolvedFormat === "ARROW";

  // Fetch data using the analytics query hook
  const {
    data: rawData,
    loading,
    error,
  } = useAnalyticsQuery(queryKey, parameters, {
    autoStart: true,
    format: resolvedFormat,
  });

  // Process and transform data
  const processedData = useMemo(() => {
    if (!rawData) return null;

    // Apply transformer if provided
    if (transformer) {
      try {
        return transformer(rawData);
      } catch (err) {
        console.error("[useChartData] Transformer error:", err);
        return rawData;
      }
    }

    return rawData;
  }, [rawData, transformer]);

  // Determine if data is empty
  const isEmpty = useMemo(() => {
    if (!processedData) return true;

    // Arrow Table - check using duck typing
    if (
      typeof processedData === "object" &&
      "numRows" in processedData &&
      typeof (processedData as Table).numRows === "number"
    ) {
      return (processedData as Table).numRows === 0;
    }

    // JSON Array
    if (Array.isArray(processedData)) {
      return processedData.length === 0;
    }

    return true;
  }, [processedData]);

  // Detect actual data type (may differ from requested if server doesn't support format)
  const isArrow = useMemo(() => {
    if (!processedData) return isArrowFormat;
    // Duck type check for Arrow Table
    return (
      typeof processedData === "object" &&
      processedData !== null &&
      "schema" in processedData &&
      "numRows" in processedData &&
      typeof (processedData as Table).getChild === "function"
    );
  }, [processedData, isArrowFormat]);

  return {
    data: processedData as ChartData | null,
    isArrow,
    loading,
    error,
    isEmpty,
  };
}
