import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock the useAnalyticsQuery hook
const mockUseAnalyticsQuery = vi.fn();

vi.mock("../use-analytics-query", () => ({
  useAnalyticsQuery: (...args: unknown[]) => mockUseAnalyticsQuery(...args),
}));

// Import after mocking
import { useChartData } from "../use-chart-data";

describe("useChartData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loading states", () => {
    test("returns loading state when query is in progress", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: null,
        loading: true,
        error: null,
      });

      const { result } = renderHook(() =>
        useChartData({ queryKey: "test_query" }),
      );

      expect(result.current.loading).toBe(true);
      expect(result.current.data).toBeNull();
      expect(result.current.error).toBeNull();
    });

    test("returns data when query completes", () => {
      const mockData = [
        { name: "A", value: 100 },
        { name: "B", value: 200 },
      ];

      mockUseAnalyticsQuery.mockReturnValue({
        data: mockData,
        loading: false,
        error: null,
      });

      const { result } = renderHook(() =>
        useChartData({ queryKey: "test_query" }),
      );

      expect(result.current.loading).toBe(false);
      expect(result.current.data).toEqual(mockData);
      expect(result.current.isEmpty).toBe(false);
    });

    test("returns error state on failure", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: null,
        loading: false,
        error: "Query failed",
      });

      const { result } = renderHook(() =>
        useChartData({ queryKey: "test_query" }),
      );

      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe("Query failed");
      expect(result.current.data).toBeNull();
    });
  });

  describe("format selection", () => {
    test("uses JSON_ARRAY format when explicitly specified", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: [],
        loading: false,
        error: null,
      });

      renderHook(() =>
        useChartData({
          queryKey: "test",
          format: "json_array",
        }),
      );

      expect(mockUseAnalyticsQuery).toHaveBeenCalledWith(
        "test",
        undefined,
        expect.objectContaining({ format: "JSON_ARRAY" }),
      );
    });

    test("uses ARROW_STREAM format when explicitly specified", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: [],
        loading: false,
        error: null,
      });

      renderHook(() =>
        useChartData({
          queryKey: "test",
          format: "arrow_stream",
        }),
      );

      expect(mockUseAnalyticsQuery).toHaveBeenCalledWith(
        "test",
        undefined,
        expect.objectContaining({ format: "ARROW_STREAM" }),
      );
    });

    test("auto-selects ARROW_STREAM for large limit", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: [],
        loading: false,
        error: null,
      });

      renderHook(() =>
        useChartData({
          queryKey: "test",
          parameters: { limit: 1000 },
          format: "auto",
        }),
      );

      expect(mockUseAnalyticsQuery).toHaveBeenCalledWith(
        "test",
        { limit: 1000 },
        expect.objectContaining({ format: "ARROW_STREAM" }),
      );
    });

    test("auto-selects ARROW_STREAM for date range queries", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: [],
        loading: false,
        error: null,
      });

      renderHook(() =>
        useChartData({
          queryKey: "test",
          parameters: {
            startDate: "2025-01-01",
            endDate: "2025-12-31",
          },
          format: "auto",
        }),
      );

      expect(mockUseAnalyticsQuery).toHaveBeenCalledWith(
        "test",
        expect.objectContaining({ startDate: "2025-01-01" }),
        expect.objectContaining({ format: "ARROW_STREAM" }),
      );
    });

    test("respects _preferJson hint", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: [],
        loading: false,
        error: null,
      });

      renderHook(() =>
        useChartData({
          queryKey: "test",
          parameters: { _preferJson: true },
          format: "auto",
        }),
      );

      expect(mockUseAnalyticsQuery).toHaveBeenCalledWith(
        "test",
        expect.anything(),
        expect.objectContaining({ format: "JSON_ARRAY" }),
      );
    });

    test("respects _preferArrow hint", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: [],
        loading: false,
        error: null,
      });

      renderHook(() =>
        useChartData({
          queryKey: "test",
          parameters: { _preferArrow: true },
          format: "auto",
        }),
      );

      expect(mockUseAnalyticsQuery).toHaveBeenCalledWith(
        "test",
        expect.anything(),
        expect.objectContaining({ format: "ARROW_STREAM" }),
      );
    });

    test("auto-selects ARROW_STREAM by default when no heuristics match", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: [],
        loading: false,
        error: null,
      });

      renderHook(() =>
        useChartData({
          queryKey: "test",
          parameters: { limit: 100 }, // Below ARROW_THRESHOLD (500)
          format: "auto",
        }),
      );

      expect(mockUseAnalyticsQuery).toHaveBeenCalledWith(
        "test",
        { limit: 100 },
        expect.objectContaining({ format: "ARROW_STREAM" }),
      );
    });

    test("defaults to auto format (ARROW_STREAM) when format is not specified", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: [],
        loading: false,
        error: null,
      });

      renderHook(() =>
        useChartData({
          queryKey: "test",
        }),
      );

      expect(mockUseAnalyticsQuery).toHaveBeenCalledWith(
        "test",
        undefined,
        expect.objectContaining({ format: "ARROW_STREAM" }),
      );
    });
  });

  describe("isEmpty detection", () => {
    test("detects empty JSON array", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: [],
        loading: false,
        error: null,
      });

      const { result } = renderHook(() => useChartData({ queryKey: "test" }));

      expect(result.current.isEmpty).toBe(true);
    });

    test("detects non-empty JSON array", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: [{ a: 1 }],
        loading: false,
        error: null,
      });

      const { result } = renderHook(() => useChartData({ queryKey: "test" }));

      expect(result.current.isEmpty).toBe(false);
    });

    test("detects empty Arrow table", () => {
      const mockArrowTable = {
        schema: {},
        numRows: 0,
        getChild: () => null,
      };

      mockUseAnalyticsQuery.mockReturnValue({
        data: mockArrowTable,
        loading: false,
        error: null,
      });

      const { result } = renderHook(() => useChartData({ queryKey: "test" }));

      expect(result.current.isEmpty).toBe(true);
    });

    test("detects non-empty Arrow table", () => {
      const mockArrowTable = {
        schema: {},
        numRows: 100,
        getChild: () => null,
      };

      mockUseAnalyticsQuery.mockReturnValue({
        data: mockArrowTable,
        loading: false,
        error: null,
      });

      const { result } = renderHook(() => useChartData({ queryKey: "test" }));

      expect(result.current.isEmpty).toBe(false);
    });

    test("returns isEmpty=true when data is null", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: null,
        loading: false,
        error: null,
      });

      const { result } = renderHook(() => useChartData({ queryKey: "test" }));

      expect(result.current.isEmpty).toBe(true);
    });
  });

  describe("isArrow detection", () => {
    test("detects Arrow table", () => {
      const mockArrowTable = {
        schema: {},
        numRows: 10,
        getChild: () => null,
      };

      mockUseAnalyticsQuery.mockReturnValue({
        data: mockArrowTable,
        loading: false,
        error: null,
      });

      const { result } = renderHook(() => useChartData({ queryKey: "test" }));

      expect(result.current.isArrow).toBe(true);
    });

    test("detects JSON array", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: [{ a: 1 }],
        loading: false,
        error: null,
      });

      const { result } = renderHook(() => useChartData({ queryKey: "test" }));

      expect(result.current.isArrow).toBe(false);
    });

    test("isArrow reflects requested ARROW_STREAM format when data is null", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: null,
        loading: true,
        error: null,
      });

      const { result } = renderHook(() =>
        useChartData({ queryKey: "test", format: "arrow_stream" }),
      );

      expect(result.current.isArrow).toBe(true);
    });

    test("isArrow reflects requested JSON_ARRAY format when data is null", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: null,
        loading: true,
        error: null,
      });

      const { result } = renderHook(() =>
        useChartData({ queryKey: "test", format: "json_array" }),
      );

      expect(result.current.isArrow).toBe(false);
    });
  });

  describe("transformer", () => {
    test("applies transformer to data", () => {
      const mockData = [{ value: 10 }, { value: 20 }];

      mockUseAnalyticsQuery.mockReturnValue({
        data: mockData,
        loading: false,
        error: null,
      });

      const transformer = vi.fn(<T>(data: T): T => {
        const arr = data as { value: number }[];
        return arr.map((d) => ({ ...d, doubled: d.value * 2 })) as T;
      });

      const { result } = renderHook(() =>
        useChartData({
          queryKey: "test",
          transformer,
        }),
      );

      expect(transformer).toHaveBeenCalledWith(mockData);
      expect(result.current.data).toEqual([
        { value: 10, doubled: 20 },
        { value: 20, doubled: 40 },
      ]);
    });

    test("handles transformer errors gracefully", () => {
      const mockData = [{ value: 10 }];

      mockUseAnalyticsQuery.mockReturnValue({
        data: mockData,
        loading: false,
        error: null,
      });

      const transformer = vi.fn(() => {
        throw new Error("Transform failed");
      });

      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const { result } = renderHook(() =>
        useChartData({
          queryKey: "test",
          transformer,
        }),
      );

      // Should return original data on transformer error
      expect(result.current.data).toEqual(mockData);
      expect(consoleSpy).toHaveBeenCalledWith(
        "[useChartData] Transformer error:",
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });

    test("does not apply transformer when data is null", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: null,
        loading: false,
        error: null,
      });

      const transformer = vi.fn();

      renderHook(() =>
        useChartData({
          queryKey: "test",
          transformer,
        }),
      );

      expect(transformer).not.toHaveBeenCalled();
    });
  });

  describe("parameters", () => {
    test("passes parameters to useAnalyticsQuery", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: null,
        loading: true,
        error: null,
      });

      const params = { limit: 50, filter: "active" };

      renderHook(() =>
        useChartData({
          queryKey: "test",
          parameters: params,
        }),
      );

      expect(mockUseAnalyticsQuery).toHaveBeenCalledWith(
        "test",
        params,
        expect.any(Object),
      );
    });

    test("passes autoStart: true to useAnalyticsQuery", () => {
      mockUseAnalyticsQuery.mockReturnValue({
        data: null,
        loading: true,
        error: null,
      });

      renderHook(() => useChartData({ queryKey: "test" }));

      expect(mockUseAnalyticsQuery).toHaveBeenCalledWith(
        "test",
        undefined,
        expect.objectContaining({ autoStart: true }),
      );
    });
  });
});
