import { useMemo } from "react";
import { useAnalyticsQuery } from "./use-analytics-query";

const MAX_DATA_POINTS = 5000;

/**
 * Options for the useChartData hook
 * @template T - The raw data type return by the analytics query
 * @param queryKey - The query key to fetch the data
 * @param parameters - The parameters to pass to the query
 * @param transformer - A custom transformer function to transform the data
 * @returns - The processed data, loading state, error state and empty state
 */
export interface UseChartDataOptions<TRaw = any, TProcessed = any> {
  queryKey: string;
  parameters: Record<string, any>;
  transformer?: (data: TRaw[]) => TProcessed[];
}

/**
 * Result of the useChartData hook
 * @template TProcessed - The processed data type
 * @param data - The processed data
 * @param loading - The loading state
 * @param error - The error state
 * @param isEmpty - Whether the data is empty
 */
export interface UseChartDataResult<TProcessed = any> {
  data: TProcessed[];
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
}

/**
 * Hook for fetching, processing and validating chart data with automatic state management
 * @template TRaw - The raw data type return by the analytics query
 * @template TProcessed - The processed data type
 * @param options - Configuration options for data fetching and processing
 * @returns Object containing the processed data, loading state, error state and empty state
 */
export function useChartData<TRaw = any, TProcessed = any>(
  options: UseChartDataOptions<TRaw, TProcessed>,
): UseChartDataResult<TProcessed> {
  const { queryKey, parameters, transformer } = options;

  const {
    data: rawData,
    loading,
    error,
  } = useAnalyticsQuery<TRaw[]>(queryKey, parameters);

  const processedData = useMemo(() => {
    if (!rawData || rawData.length === 0 || !Array.isArray(rawData)) return [];

    const validData = rawData.filter(
      (item) => item && typeof item === "object" && !Array.isArray(item),
    );

    if (validData.length === 0) return [];

    const isSizeValid = validData.length <= MAX_DATA_POINTS;

    try {
      if (isSizeValid) {
        return transformer ? transformer(validData) : autoTransform(validData);
      }
      console.warn(
        `Chart data truncated from ${validData.length} to ${MAX_DATA_POINTS} points. Consider server-side aggregation for better performance.`,
      );
      const truncatedData = validData.slice(0, MAX_DATA_POINTS);

      return transformer
        ? transformer(truncatedData)
        : autoTransform(truncatedData);
    } catch (error) {
      console.error("Error processing data:", error);
      return [];
    }
  }, [rawData, transformer]);

  const isEmpty = useMemo(() => {
    return (
      !Array.isArray(processedData) ||
      processedData.length === 0 ||
      !processedData[0] ||
      Object.keys(processedData[0]).length === 0
    );
  }, [processedData]);

  return {
    data: processedData,
    loading,
    error,
    isEmpty,
  };
}

/**
 * automatically transform the data if the transformer is not provided
 * @param data - The raw data to transform
 * @returns - The transformed data with correct types
 */
export const autoTransform = (data: any[]) => {
  if (!data || !Array.isArray(data) || data.length === 0) return [];

  const firstItem = data[0];
  const keys = Object.keys(firstItem);

  // detect numeric keys
  const numericKeys = keys.filter((key) => {
    const val = firstItem[key];
    if (typeof val !== "string" || val.trim() === "") return false;

    // avoid date fields
    if (/^\d{4}-\d{2}-\d{2}/.test(val)) return false;

    // check if it's a string that is a valid number
    const parsed = parseFloat(val);
    return !Number.isNaN(parsed) && Number.isFinite(parsed);
  });

  // if no conversion needed, return original
  if (numericKeys.length === 0) return data;

  // convert identified fields to numbers
  return data.map((item) => {
    const newItem = { ...item };
    numericKeys.forEach((key) => {
      const val = item[key];
      if (typeof val === "string") {
        // parse string to number
        const parsed = parseFloat(val);
        newItem[key] =
          Number.isFinite(parsed) && Math.abs(parsed) < Number.MAX_SAFE_INTEGER
            ? parsed
            : 0;
      }
    });
    return newItem;
  });
};
