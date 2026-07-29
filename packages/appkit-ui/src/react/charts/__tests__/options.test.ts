import { describe, expect, test } from "vitest";
import { FALLBACK_UI_TOKENS } from "../constants";
import {
  applySelectionEmphasis,
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
  tooltip?: {
    formatter?: (params: { data: [number, number, number] }) => string;
    backgroundColor?: string;
    borderColor?: string;
    textStyle?: { color: string };
  };
  xAxis: { type: string; data?: unknown[] };
  yAxis: { type: string; data?: unknown[] };
  series: Array<{
    type: string;
    data: unknown[];
    smooth?: boolean;
    showSymbol?: boolean;
    symbol?: string;
    symbolSize?: number;
    triggerLineEvent?: boolean;
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

// Distinct UI tokens so theming assertions are unambiguous
const TEST_UI = {
  axisLabel: "#a11111",
  axisTitle: "#b22222",
  grid: "#c33333",
  tooltipBg: "#d44444",
};

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
  ui: TEST_UI,
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

    test("applies symbolSize to line series (not just scatter)", () => {
      const ctx = createBaseContext();
      const opt = asOption(
        buildCartesianOption({
          ...ctx,
          chartType: "line",
          isTimeSeries: false,
          stacked: false,
          smooth: true,
          showSymbol: true,
          symbolSize: 14,
        }),
      );

      expect(opt.series[0].symbolSize).toBe(14);
    });

    test("sets triggerLineEvent only when interactive", () => {
      const ctx = createBaseContext();
      const base = {
        ...ctx,
        chartType: "line" as const,
        isTimeSeries: false,
        stacked: false,
        smooth: true,
        showSymbol: true,
        symbolSize: 8,
      };

      // Non-interactive line: no triggerLineEvent.
      expect(
        asOption(buildCartesianOption(base)).series[0].triggerLineEvent,
      ).toBeUndefined();

      // Interactive line: whole stroke is clickable.
      expect(
        asOption(buildCartesianOption({ ...base, interactive: true })).series[0]
          .triggerLineEvent,
      ).toBe(true);
    });

    test("does not set triggerLineEvent on a bar series even when interactive", () => {
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
          interactive: true,
        }),
      );

      expect(opt.series[0].triggerLineEvent).toBeUndefined();
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
    ui: TEST_UI,
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

  test("tooltip formatter renders labels and values", () => {
    const ctx = createHeatmapContext();
    const opt = asOption(buildHeatmapOption(ctx));

    const output = opt.tooltip?.formatter?.({ data: [1, 2, 25] });
    expect(output).toBe("10AM, Wed: 25");
  });

  test("tooltip formatter escapes HTML in category values (XSS)", () => {
    const ctx = {
      ...createHeatmapContext(),
      xData: ["<img src=x onerror=alert(1)>", "10AM"],
      yAxisData: ["<script>alert(2)</script>", "Tue"],
    };
    const opt = asOption(buildHeatmapOption(ctx));

    const output = opt.tooltip?.formatter?.({ data: [0, 0, 10] });
    expect(output).not.toContain("<");
    expect(output).not.toContain(">");
    expect(output).toBe(
      "&lt;img src=x onerror=alert(1)&gt;, &lt;script&gt;alert(2)&lt;/script&gt;: 10",
    );
  });
});

describe("axis & UI theming", () => {
  type AxisShape = {
    axisLabel: { color?: string; rotate?: number; width?: number };
    axisLine: { lineStyle: { color: string } };
    axisTick: { lineStyle: { color: string } };
    splitLine: { lineStyle: { color: string } };
    nameTextStyle?: { color: string };
  };
  type TextStyled = { textStyle: { color: string } };

  test("applies ui tokens to cartesian axes, title, and legend", () => {
    const ctx = createBaseContext({
      yFields: ["a", "b"],
      yDataMap: { a: [1, 2], b: [3, 4] },
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

    const xAxis = opt.xAxis as AxisShape;
    const yAxis = opt.yAxis as AxisShape;
    expect(xAxis.axisLabel.color).toBe(TEST_UI.axisLabel);
    expect(xAxis.axisLine.lineStyle.color).toBe(TEST_UI.grid);
    expect(yAxis.axisLabel.color).toBe(TEST_UI.axisLabel);
    expect(yAxis.splitLine.lineStyle.color).toBe(TEST_UI.grid);
    expect((opt.title as TextStyled).textStyle.color).toBe(TEST_UI.axisTitle);
    expect((opt.legend as TextStyled).textStyle.color).toBe(TEST_UI.axisTitle);
  });

  test("preserves x-axis formatter/rotate while setting label color", () => {
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

    const xAxis = opt.xAxis as AxisShape;
    expect(xAxis.axisLabel.color).toBe(TEST_UI.axisLabel);
    expect(xAxis.axisLabel.rotate).toBe(45);
  });

  test("applies ui tokens to horizontal bar axes (preserving label width)", () => {
    const ctx = createBaseContext();
    const opt = buildHorizontalBarOption(ctx, false);

    const xAxis = opt.xAxis as AxisShape;
    const yAxis = opt.yAxis as AxisShape;
    expect(yAxis.axisLabel.color).toBe(TEST_UI.axisLabel);
    expect(yAxis.axisLabel.width).toBe(100);
    expect(xAxis.axisLine.lineStyle.color).toBe(TEST_UI.grid);
  });

  test("applies ui tokens to heatmap axes and visualMap", () => {
    const ctx: HeatmapContext = {
      ...createBaseContext({ showLegend: false }),
      yAxisData: ["Mon", "Tue"],
      heatmapData: [
        [0, 0, 10],
        [1, 0, 20],
      ],
      min: 10,
      max: 20,
      showLabels: false,
    };
    const opt = buildHeatmapOption(ctx);

    expect((opt.xAxis as AxisShape).axisLabel.color).toBe(TEST_UI.axisLabel);
    expect((opt.yAxis as AxisShape).axisLabel.color).toBe(TEST_UI.axisLabel);
    expect((opt.visualMap as TextStyled).textStyle.color).toBe(
      TEST_UI.axisTitle,
    );
  });

  test("applies ui tokens to pie legend", () => {
    const ctx = createBaseContext({ showLegend: true });
    const opt = buildPieOption(ctx, "pie", 0, true, "outside");
    expect((opt.legend as TextStyled).textStyle.color).toBe(TEST_UI.axisTitle);
  });

  test("applies ui tokens to radar", () => {
    const ctx = createBaseContext();
    const opt = buildRadarOption(ctx, true);
    const radar = opt.radar as {
      axisName: { color: string };
      axisLine: { lineStyle: { color: string } };
      splitLine: { lineStyle: { color: string } };
    };
    expect(radar.axisName.color).toBe(TEST_UI.axisTitle);
    expect(radar.splitLine.lineStyle.color).toBe(TEST_UI.grid);
  });

  test("applies ui tokens to radar legend (multi-series)", () => {
    const ctx = createBaseContext({
      yFields: ["a", "b"],
      yDataMap: { a: [1, 2, 3], b: [4, 5, 6] },
      showLegend: true,
    });
    const opt = buildRadarOption(ctx, true);
    expect((opt.legend as TextStyled).textStyle.color).toBe(TEST_UI.axisTitle);
  });

  test("applies axis-label color on scatter x-axis", () => {
    const ctx = createBaseContext();
    const opt = buildCartesianOption({
      ...ctx,
      chartType: "scatter",
      isTimeSeries: false,
      stacked: false,
      smooth: false,
      showSymbol: false,
      symbolSize: 8,
    });
    expect((opt.xAxis as AxisShape).axisLabel.color).toBe(TEST_UI.axisLabel);
  });

  test("applies axis-label color on time-series x-axis", () => {
    const ctx = createBaseContext();
    const opt = buildCartesianOption({
      ...ctx,
      chartType: "line",
      isTimeSeries: true,
      stacked: false,
      smooth: false,
      showSymbol: false,
      symbolSize: 8,
    });
    expect((opt.xAxis as AxisShape).axisLabel.color).toBe(TEST_UI.axisLabel);
  });

  test("falls back to default UI tokens when ui is omitted", () => {
    const ctx = createBaseContext({ ui: undefined });
    const opt = buildCartesianOption({
      ...ctx,
      chartType: "bar",
      isTimeSeries: false,
      stacked: false,
      smooth: false,
      showSymbol: false,
      symbolSize: 8,
    });

    expect((opt.xAxis as AxisShape).axisLabel.color).toBe(
      FALLBACK_UI_TOKENS.axisLabel,
    );
    expect((opt.yAxis as AxisShape).splitLine.lineStyle.color).toBe(
      FALLBACK_UI_TOKENS.grid,
    );
    expect((opt.title as TextStyled).textStyle.color).toBe(
      FALLBACK_UI_TOKENS.axisTitle,
    );
    expect((opt.tooltip as { backgroundColor: string }).backgroundColor).toBe(
      FALLBACK_UI_TOKENS.tooltipBg,
    );
  });
});

describe("tooltip theming", () => {
  test("themes cartesian tooltip (background, border, text)", () => {
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

    expect(opt.tooltip?.backgroundColor).toBe(TEST_UI.tooltipBg);
    expect(opt.tooltip?.borderColor).toBe(TEST_UI.grid);
    expect(opt.tooltip?.textStyle?.color).toBe(TEST_UI.axisTitle);
  });

  test("themes horizontal bar tooltip while keeping axisPointer", () => {
    const ctx = createBaseContext();
    const opt = asOption(buildHorizontalBarOption(ctx, false));

    expect(opt.tooltip?.backgroundColor).toBe(TEST_UI.tooltipBg);
    expect(
      (opt.tooltip as { axisPointer?: { type: string } }).axisPointer?.type,
    ).toBe("shadow");
  });

  test("themes pie tooltip while keeping the formatter", () => {
    const ctx = createBaseContext();
    const opt = asOption(buildPieOption(ctx, "pie", 0, true, "outside"));

    expect(opt.tooltip?.backgroundColor).toBe(TEST_UI.tooltipBg);
    expect(opt.tooltip?.borderColor).toBe(TEST_UI.grid);
    expect((opt.tooltip as { formatter?: string }).formatter).toBe(
      "{b}: {c} ({d}%)",
    );
  });

  test("themes radar tooltip", () => {
    const ctx = createBaseContext();
    const opt = asOption(buildRadarOption(ctx, true));

    expect(opt.tooltip?.backgroundColor).toBe(TEST_UI.tooltipBg);
    expect(opt.tooltip?.textStyle?.color).toBe(TEST_UI.axisTitle);
  });

  test("themes heatmap tooltip while keeping the escaping formatter", () => {
    const ctx: HeatmapContext = {
      ...createBaseContext({ showLegend: false }),
      yAxisData: ["Mon", "Tue"],
      heatmapData: [
        [0, 0, 10],
        [1, 0, 20],
      ],
      min: 10,
      max: 20,
      showLabels: false,
    };
    const opt = asOption(buildHeatmapOption(ctx));

    expect(opt.tooltip?.backgroundColor).toBe(TEST_UI.tooltipBg);
    expect(opt.tooltip?.borderColor).toBe(TEST_UI.grid);
    // Formatter still runs (and still escapes) on top of the themed tooltip.
    expect(opt.tooltip?.formatter?.({ data: [0, 0, 10] })).toBe("A, Mon: 10");
  });
});

// ============================================================================
// applySelectionEmphasis — the cross-filter highlight transform
// ============================================================================

describe("applySelectionEmphasis", () => {
  // Minimal helpers to read opacity off a transformed datum, tolerating both the
  // object form ({ value, itemStyle }) and the wrapped-primitive form.
  const opacityOf = (datum: unknown): number | undefined =>
    (datum as { itemStyle?: { opacity?: number } })?.itemStyle?.opacity;

  const barOption = (categories: (string | number)[], values: number[]) => ({
    xAxis: { type: "category", data: categories },
    yAxis: { type: "value" },
    series: [{ type: "bar", data: values }],
  });

  describe("no-op cases (identity)", () => {
    test("undefined selection returns the input unchanged (same reference)", () => {
      const opt = barOption(["EMEA", "APAC"], [10, 20]);
      expect(applySelectionEmphasis(opt, undefined)).toBe(opt);
    });

    test("empty-string selection is a no-op — does NOT dim everything (guards #4)", () => {
      const opt = barOption(["EMEA", "APAC"], [10, 20]);
      // The bug being guarded: "" would match no category and dim all bars.
      expect(applySelectionEmphasis(opt, "")).toBe(opt);
    });

    test("empty-array selection is a no-op", () => {
      const opt = barOption(["EMEA", "APAC"], [10, 20]);
      expect(applySelectionEmphasis(opt, [])).toBe(opt);
    });

    test("an array of only empty strings is a no-op", () => {
      const opt = barOption(["EMEA", "APAC"], [10, 20]);
      expect(applySelectionEmphasis(opt, ["", ""])).toBe(opt);
    });

    test("option without a series array is returned unchanged", () => {
      const opt = { xAxis: { type: "category", data: ["A"] } };
      expect(applySelectionEmphasis(opt, "A")).toBe(opt);
    });
  });

  describe("bar series (category axis)", () => {
    test("dims non-selected categories and keeps the selected one at full opacity", () => {
      const opt = barOption(["EMEA", "APAC", "AMER"], [10, 20, 30]);
      const out = asOption(applySelectionEmphasis(opt, "APAC"));

      const data = out.series[0].data;
      expect(opacityOf(data[0])).toBe(0.3); // EMEA dimmed
      expect(opacityOf(data[1])).toBe(1); // APAC selected
      expect(opacityOf(data[2])).toBe(0.3); // AMER dimmed
    });

    test("a mixed array selection ignores the dead empty-string member", () => {
      const opt = barOption(["EMEA", "APAC", "AMER"], [10, 20, 30]);
      const out = asOption(applySelectionEmphasis(opt, ["EMEA", "", "AMER"]));

      const data = out.series[0].data;
      expect(opacityOf(data[0])).toBe(1); // EMEA selected
      expect(opacityOf(data[1])).toBe(0.3); // APAC dimmed
      expect(opacityOf(data[2])).toBe(1); // AMER selected
    });

    test("preserves the series-level itemStyle (bar borderRadius) via a real builder", () => {
      const ctx = createBaseContext({
        xData: ["EMEA", "APAC"],
        yDataMap: { value: [10, 20] },
      });
      const built = buildCartesianOption({
        ...ctx,
        chartType: "bar",
        isTimeSeries: false,
        stacked: false,
        smooth: false,
        showSymbol: false,
        symbolSize: 8,
      });
      const out = asOption(applySelectionEmphasis(built, "EMEA"));

      // The per-datum itemStyle carries opacity but the bar's borderRadius is
      // set at the series level and must survive (per-datum merges OVER series).
      expect(opacityOf(out.series[0].data[0])).toBe(1);
      expect(opacityOf(out.series[0].data[1])).toBe(0.3);
      expect(out.series[0].itemStyle?.borderRadius).toEqual([4, 4, 0, 0]);
    });

    test("matches numeric category names by their string form", () => {
      const opt = barOption([2024, 2025, 2026], [10, 20, 30]);
      const out = asOption(applySelectionEmphasis(opt, "2025"));

      const data = out.series[0].data;
      expect(opacityOf(data[0])).toBe(0.3);
      expect(opacityOf(data[1])).toBe(1);
      expect(opacityOf(data[2])).toBe(0.3);
    });

    test("respects custom opacity overrides", () => {
      const opt = barOption(["EMEA", "APAC"], [10, 20]);
      const out = asOption(
        applySelectionEmphasis(opt, "EMEA", {
          dimmedOpacity: 0.1,
          selectedOpacity: 0.9,
        }),
      );
      expect(opacityOf(out.series[0].data[0])).toBe(0.9);
      expect(opacityOf(out.series[0].data[1])).toBe(0.1);
    });

    test("horizontal bars read categories from the yAxis", () => {
      const ctx = createBaseContext({
        xData: ["EMEA", "APAC", "AMER"],
        yDataMap: { value: [10, 20, 30] },
      });
      const built = buildHorizontalBarOption(ctx, false);
      const out = asOption(applySelectionEmphasis(built, "APAC"));

      const data = out.series[0].data;
      expect(opacityOf(data[0])).toBe(0.3);
      expect(opacityOf(data[1])).toBe(1);
      expect(opacityOf(data[2])).toBe(0.3);
    });
  });

  describe("pie series (name-keyed data)", () => {
    test("dims non-selected slices, reading the name off each datum", () => {
      const ctx = createBaseContext({
        xData: ["EMEA", "APAC", "AMER"],
        yDataMap: { value: [10, 20, 30] },
        yFields: ["value"],
      });
      const built = buildPieOption(ctx, "pie", 0, true, "outside");
      const out = asOption(applySelectionEmphasis(built, "AMER"));

      const data = out.series[0].data as Array<{
        name: string;
        itemStyle?: { opacity?: number };
      }>;
      // Object data items are spread — name/value survive alongside opacity.
      expect(data[0]).toMatchObject({ name: "EMEA" });
      expect(data[0].itemStyle?.opacity).toBe(0.3);
      expect(data[2].itemStyle?.opacity).toBe(1);
    });
  });

  describe("non-categorical series are passed through untouched", () => {
    test("line series (no category name per datum) is unchanged", () => {
      const opt = {
        xAxis: { type: "category", data: ["A", "B"] },
        yAxis: { type: "value" },
        series: [{ type: "line", data: [10, 20] }],
      };
      const out = asOption(applySelectionEmphasis(opt, "A"));
      // Line data is left as raw values (no itemStyle wrapping).
      expect(out.series[0].data).toEqual([10, 20]);
    });

    test("scatter series is unchanged", () => {
      const opt = {
        xAxis: { type: "value" },
        yAxis: { type: "value" },
        series: [
          {
            type: "scatter",
            data: [
              [1, 2],
              [3, 4],
            ],
          },
        ],
      };
      const out = asOption(applySelectionEmphasis(opt, "anything"));
      expect(out.series[0].data).toEqual([
        [1, 2],
        [3, 4],
      ]);
    });

    test("bar with no category axis (e.g. value/value) is left unchanged", () => {
      const opt = {
        xAxis: { type: "value" },
        yAxis: { type: "value" },
        series: [{ type: "bar", data: [10, 20] }],
      };
      const out = asOption(applySelectionEmphasis(opt, "A"));
      expect(out.series[0].data).toEqual([10, 20]);
    });
  });
});
