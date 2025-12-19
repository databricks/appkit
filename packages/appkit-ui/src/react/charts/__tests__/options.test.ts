import { describe, expect, test } from "vitest";
import {
  buildCartesianOption,
  buildHeatmapOption,
  buildHorizontalBarOption,
  buildPieOption,
  buildRadarOption,
  type HeatmapContext,
  type OptionBuilderContext,
} from "../options";

interface EChartsOption {
  title?: { text?: string };
  legend?: unknown;
  xAxis: { type: string; data?: unknown[] };
  yAxis: { type: string; data?: unknown[] };
  series: Array<{
    type: string;
    data: unknown[];
    smooth?: boolean;
    showSymbol?: boolean;
    symbol?: string;
    symbolSize?: number;
    areaStyle?: { opacity: number };
    stack?: string;
    itemStyle?: { borderRadius?: number[] };
    color?: string;
    label?: { show: boolean; position: string };
    radius?: string | string[];
  }>;
  radar?: {
    indicator: Array<{ name: string; max: number }>;
  };
  visualMap?: {
    min: number;
    max: number;
    inRange: { color: string[] };
  };
}

interface RadarOption {
  series: Array<{
    type: string;
    data: Array<{ value: number[]; areaStyle?: { opacity: number } }>;
  }>;
}

/** Cast result to EChartsOption for testing */
function asOption(result: Record<string, unknown>): EChartsOption {
  return result as unknown as EChartsOption;
}

/** Cast result to RadarOption for testing */
function asRadarOption(result: Record<string, unknown>): RadarOption {
  return result as unknown as RadarOption;
}

// Base context used across tests
const createBaseContext = (
  overrides: Partial<OptionBuilderContext> = {},
): OptionBuilderContext => ({
  xData: ["A", "B", "C"],
  yDataMap: { value: [10, 20, 30] },
  yFields: ["value"],
  colors: ["#ff0000", "#00ff00", "#0000ff"],
  title: "Test Chart",
  showLegend: true,
  ...overrides,
});

describe("buildCartesianOption", () => {
  describe("bar chart", () => {
    test("creates basic bar chart option", () => {
      const ctx = createBaseContext();
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "bar",
          isTimeSeries: false,
          stacked: false,
          smooth: false,
          showSymbol: false,
          symbolSize: 8,
        }),
      );

      expect(opt.series[0].type).toBe("bar");
      expect(opt.xAxis.type).toBe("category");
      expect(opt.xAxis.data).toEqual(["A", "B", "C"]);
      expect(opt.yAxis.type).toBe("value");
    });

    test("applies border radius to bars", () => {
      const ctx = createBaseContext();
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "bar",
          isTimeSeries: false,
          stacked: false,
          smooth: false,
          showSymbol: false,
          symbolSize: 8,
        }),
      );

      expect(opt.series[0].itemStyle?.borderRadius).toEqual([4, 4, 0, 0]);
    });

    test("includes title when provided", () => {
      const ctx = createBaseContext({ title: "My Chart" });
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "bar",
          isTimeSeries: false,
          stacked: false,
          smooth: false,
          showSymbol: false,
          symbolSize: 8,
        }),
      );

      expect(opt.title?.text).toBe("My Chart");
    });

    test("does not apply stacking to bar charts", () => {
      // Stacking only works for area charts, not bar charts
      const ctx = createBaseContext({
        yFields: ["a", "b"],
        yDataMap: { a: [1, 2], b: [3, 4] },
      });
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "bar",
          isTimeSeries: false,
          stacked: true,
          smooth: false,
          showSymbol: false,
          symbolSize: 8,
        }),
      );

      expect(opt.series[0].stack).toBeUndefined();
      expect(opt.series[1].stack).toBeUndefined();
    });
  });

  describe("line chart", () => {
    test("creates line chart with smooth curves", () => {
      const ctx = createBaseContext();
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "line",
          isTimeSeries: false,
          stacked: false,
          smooth: true,
          showSymbol: true,
          symbolSize: 8,
        }),
      );

      expect(opt.series[0].type).toBe("line");
      expect(opt.series[0].smooth).toBe(true);
      expect(opt.series[0].showSymbol).toBe(true);
    });

    test("creates line chart without smooth curves", () => {
      const ctx = createBaseContext();
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "line",
          isTimeSeries: false,
          stacked: false,
          smooth: false,
          showSymbol: false,
          symbolSize: 8,
        }),
      );

      expect(opt.series[0].smooth).toBe(false);
      expect(opt.series[0].showSymbol).toBe(false);
    });
  });

  describe("area chart", () => {
    test("creates area chart with areaStyle", () => {
      const ctx = createBaseContext();
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "area",
          isTimeSeries: false,
          stacked: false,
          smooth: true,
          showSymbol: false,
          symbolSize: 8,
        }),
      );

      // Area chart uses line type with areaStyle
      expect(opt.series[0].type).toBe("line");
      expect(opt.series[0].areaStyle).toBeDefined();
      expect(opt.series[0].areaStyle?.opacity).toBe(0.3);
    });

    test("stacks area charts when stacked=true", () => {
      const ctx = createBaseContext({
        yFields: ["value1", "value2"],
        yDataMap: { value1: [10, 20], value2: [30, 40] },
      });
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "area",
          isTimeSeries: false,
          stacked: true,
          smooth: true,
          showSymbol: false,
          symbolSize: 8,
        }),
      );

      expect(opt.series[0].stack).toBe("total");
      expect(opt.series[1].stack).toBe("total");
    });
  });

  describe("scatter chart", () => {
    test("creates scatter chart with circle symbols", () => {
      const ctx = createBaseContext();
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "scatter",
          isTimeSeries: false,
          stacked: false,
          smooth: false,
          showSymbol: false,
          symbolSize: 8,
        }),
      );

      expect(opt.series[0].type).toBe("scatter");
      expect(opt.series[0].symbol).toBe("circle");
      expect(opt.series[0].symbolSize).toBe(8);
    });

    test("applies custom symbolSize", () => {
      const ctx = createBaseContext();
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "scatter",
          isTimeSeries: false,
          stacked: false,
          smooth: false,
          showSymbol: false,
          symbolSize: 15,
        }),
      );

      expect(opt.series[0].symbolSize).toBe(15);
    });
  });

  describe("time-series", () => {
    test("uses time axis for time-series data", () => {
      const ctx = createBaseContext({
        xData: [1704067200000, 1704153600000, 1704240000000],
      });
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "line",
          isTimeSeries: true,
          stacked: false,
          smooth: true,
          showSymbol: false,
          symbolSize: 8,
        }),
      );

      expect(opt.xAxis.type).toBe("time");
      expect(opt.xAxis.data).toBeUndefined();
    });

    test("formats time-series data as [timestamp, value] pairs", () => {
      const timestamps = [1704067200000, 1704153600000];
      const ctx = createBaseContext({
        xData: timestamps,
        yDataMap: { value: [100, 200] },
      });
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "line",
          isTimeSeries: true,
          stacked: false,
          smooth: true,
          showSymbol: false,
          symbolSize: 8,
        }),
      );

      // Time series data should be [timestamp, value] pairs
      expect(opt.series[0].data[0]).toEqual([timestamps[0], 100]);
      expect(opt.series[0].data[1]).toEqual([timestamps[1], 200]);
    });
  });

  describe("multiple series", () => {
    test("shows legend for multiple series", () => {
      const ctx = createBaseContext({
        yFields: ["sales", "profit"],
        yDataMap: { sales: [100, 200], profit: [20, 50] },
      });
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "bar",
          isTimeSeries: false,
          stacked: false,
          smooth: false,
          showSymbol: false,
          symbolSize: 8,
        }),
      );

      expect(opt.legend).toBeDefined();
      expect(opt.series).toHaveLength(2);
    });

    test("assigns different colors to each series", () => {
      const ctx = createBaseContext({
        yFields: ["a", "b", "c"],
        yDataMap: { a: [1], b: [2], c: [3] },
        colors: ["#red", "#green", "#blue"],
      });
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "bar",
          isTimeSeries: false,
          stacked: false,
          smooth: false,
          showSymbol: false,
          symbolSize: 8,
        }),
      );

      expect(opt.series[0].color).toBe("#red");
      expect(opt.series[1].color).toBe("#green");
      expect(opt.series[2].color).toBe("#blue");
    });

    test("hides legend for single series even when showLegend=true", () => {
      const ctx = createBaseContext({ showLegend: true });
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "bar",
          isTimeSeries: false,
          stacked: false,
          smooth: false,
          showSymbol: false,
          symbolSize: 8,
        }),
      );

      expect(opt.legend).toBeUndefined();
    });
  });

  describe("axis labels", () => {
    test("rotates x-axis labels when more than 10 items", () => {
      const ctx = createBaseContext({
        xData: Array.from({ length: 15 }, (_, i) => `Item${i}`),
        yDataMap: { value: Array(15).fill(10) },
      });
      const opt = buildCartesianOption({
        ...ctx,
        chartType: "bar",
        isTimeSeries: false,
        stacked: false,
        smooth: false,
        showSymbol: false,
        symbolSize: 8,
      });

      expect(
        (opt.xAxis as { axisLabel: { rotate: number } }).axisLabel.rotate,
      ).toBe(45);
    });

    test("does not rotate x-axis labels when 10 or fewer items", () => {
      const ctx = createBaseContext({
        xData: Array.from({ length: 10 }, (_, i) => `Item${i}`),
        yDataMap: { value: Array(10).fill(10) },
      });
      const opt = buildCartesianOption({
        ...ctx,
        chartType: "bar",
        isTimeSeries: false,
        stacked: false,
        smooth: false,
        showSymbol: false,
        symbolSize: 8,
      });

      expect(
        (opt.xAxis as { axisLabel: { rotate: number } }).axisLabel.rotate,
      ).toBe(0);
    });
  });
});

describe("buildHorizontalBarOption", () => {
  test("swaps x and y axes", () => {
    const ctx = createBaseContext();
    const opt = asOption(buildHorizontalBarOption(ctx, false));

    expect(opt.yAxis.type).toBe("category");
    expect(opt.yAxis.data).toEqual(["A", "B", "C"]);
    expect(opt.xAxis.type).toBe("value");
  });

  test("supports stacking", () => {
    const ctx = createBaseContext({
      yFields: ["a", "b"],
      yDataMap: { a: [1, 2], b: [3, 4] },
    });
    const opt = asOption(buildHorizontalBarOption(ctx, true));

    expect(opt.series[0].stack).toBe("total");
    expect(opt.series[1].stack).toBe("total");
  });

  test("applies horizontal border radius [0, 4, 4, 0]", () => {
    const ctx = createBaseContext();
    const opt = asOption(buildHorizontalBarOption(ctx, false));

    // Horizontal bars have radius on the right side
    expect(opt.series[0].itemStyle?.borderRadius).toEqual([0, 4, 4, 0]);
  });

  test("hides legend for single series", () => {
    const ctx = createBaseContext({ showLegend: true });
    const opt = asOption(buildHorizontalBarOption(ctx, false));

    expect(opt.legend).toBeUndefined();
  });

  test("shows legend for multiple series", () => {
    const ctx = createBaseContext({
      showLegend: true,
      yFields: ["a", "b"],
      yDataMap: { a: [1, 2], b: [3, 4] },
    });
    const opt = asOption(buildHorizontalBarOption(ctx, false));

    expect(opt.legend).toBeDefined();
  });
});

describe("buildPieOption", () => {
  test("creates pie chart with correct data format", () => {
    const ctx = createBaseContext();
    const opt = asOption(buildPieOption(ctx, "pie", 0, true, "outside"));

    expect(opt.series[0].type).toBe("pie");
    expect(opt.series[0].data).toHaveLength(3);
    // Pie data format is { name, value } without itemStyle colors
    expect(opt.series[0].data[0]).toEqual({
      name: "A",
      value: 10,
    });
  });

  test("creates pie chart with string radius when innerRadius=0", () => {
    const ctx = createBaseContext();
    const opt = asOption(buildPieOption(ctx, "pie", 0, true, "outside"));

    // When not a donut (innerRadius=0), radius is just "70%"
    expect(opt.series[0].radius).toBe("70%");
  });

  test("creates donut chart with inner radius", () => {
    const ctx = createBaseContext();
    const opt = asOption(buildPieOption(ctx, "donut", 50, true, "inside"));

    // Donut has array radius [innerRadius%, "70%"]
    expect(opt.series[0].radius).toEqual(["50%", "70%"]);
  });

  test("uses default inner radius for donut type", () => {
    const ctx = createBaseContext();
    const opt = asOption(buildPieOption(ctx, "donut", 0, true, "inside"));

    // Donut type with 0 innerRadius uses 40% default
    expect(opt.series[0].radius).toEqual(["40%", "70%"]);
  });

  test("shows labels when showLabels=true", () => {
    const ctx = createBaseContext();
    const opt = asOption(buildPieOption(ctx, "pie", 0, true, "outside"));

    expect(opt.series[0].label?.show).toBe(true);
    expect(opt.series[0].label?.position).toBe("outside");
  });

  test("hides labels when showLabels=false", () => {
    const ctx = createBaseContext();
    const opt = asOption(buildPieOption(ctx, "pie", 0, false, "outside"));

    expect(opt.series[0].label?.show).toBe(false);
  });

  test("supports different label positions", () => {
    const ctx = createBaseContext();

    const outside = asOption(buildPieOption(ctx, "pie", 0, true, "outside"));
    expect(outside.series[0].label?.position).toBe("outside");

    const inside = asOption(buildPieOption(ctx, "pie", 0, true, "inside"));
    expect(inside.series[0].label?.position).toBe("inside");

    const center = asOption(buildPieOption(ctx, "pie", 0, true, "center"));
    expect(center.series[0].label?.position).toBe("center");
  });
});

describe("buildRadarOption", () => {
  test("creates radar chart with indicators", () => {
    const ctx = createBaseContext();
    const opt = asOption(buildRadarOption(ctx, true));

    expect(opt.radar).toBeDefined();
    expect(opt.radar?.indicator).toHaveLength(3);
    expect(opt.radar?.indicator[0].name).toBe("A");
  });

  test("calculates max value for indicators", () => {
    const ctx = createBaseContext({
      yDataMap: { value: [10, 50, 30] },
    });
    const opt = asOption(buildRadarOption(ctx, true));

    // Max should be 50 * 1.2 = 60
    expect(opt.radar?.indicator[0].max).toBe(60);
  });

  test("shows area fill when showArea=true", () => {
    const ctx = createBaseContext();
    const opt = asRadarOption(buildRadarOption(ctx, true));

    expect(opt.series[0].data[0].areaStyle).toBeDefined();
    expect(opt.series[0].data[0].areaStyle?.opacity).toBe(0.3);
  });

  test("hides area fill when showArea=false", () => {
    const ctx = createBaseContext();
    const opt = asRadarOption(buildRadarOption(ctx, false));

    expect(opt.series[0].data[0].areaStyle).toBeUndefined();
  });

  test("creates radar series with correct structure", () => {
    const ctx = createBaseContext();
    const opt = asRadarOption(buildRadarOption(ctx, true));

    expect(opt.series[0].type).toBe("radar");
    expect(opt.series[0].data[0].value).toEqual([10, 20, 30]);
  });
});

describe("buildHeatmapOption", () => {
  const createHeatmapContext = (): HeatmapContext => ({
    xData: ["9AM", "10AM", "11AM"],
    yDataMap: {},
    yFields: [],
    colors: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    title: "Activity Heatmap",
    showLegend: false,
    // Heatmap-specific
    yAxisData: ["Mon", "Tue", "Wed"],
    heatmapData: [
      [0, 0, 10],
      [1, 0, 20],
      [2, 0, 30],
      [0, 1, 15],
      [1, 1, 25],
      [2, 1, 35],
    ],
    min: 10,
    max: 35,
    showLabels: false,
  });

  test("creates heatmap with category axes", () => {
    const ctx = createHeatmapContext();
    const opt = asOption(buildHeatmapOption(ctx));

    expect(opt.xAxis.type).toBe("category");
    expect(opt.xAxis.data).toEqual(["9AM", "10AM", "11AM"]);
    expect(opt.yAxis.type).toBe("category");
    expect(opt.yAxis.data).toEqual(["Mon", "Tue", "Wed"]);
  });

  test("creates visualMap with min/max range", () => {
    const ctx = createHeatmapContext();
    const opt = asOption(buildHeatmapOption(ctx));

    expect(opt.visualMap).toBeDefined();
    expect(opt.visualMap?.min).toBe(10);
    expect(opt.visualMap?.max).toBe(35);
  });

  test("uses provided colors for gradient", () => {
    const ctx = createHeatmapContext();
    const opt = asOption(buildHeatmapOption(ctx));

    expect(opt.visualMap?.inRange.color).toEqual(ctx.colors);
  });

  test("shows labels on cells when showLabels=true", () => {
    const ctx = { ...createHeatmapContext(), showLabels: true };
    const opt = asOption(buildHeatmapOption(ctx));

    expect(opt.series[0].label?.show).toBe(true);
  });

  test("hides labels when showLabels=false", () => {
    const ctx = { ...createHeatmapContext(), showLabels: false };
    const opt = asOption(buildHeatmapOption(ctx));

    expect(opt.series[0].label?.show).toBe(false);
  });

  test("uses heatmapData for series data", () => {
    const ctx = createHeatmapContext();
    const opt = asOption(buildHeatmapOption(ctx));

    expect(opt.series[0].data).toEqual(ctx.heatmapData);
  });
});
