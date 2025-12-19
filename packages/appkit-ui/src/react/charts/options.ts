import type { ChartType } from "./types";
import { createTimeSeriesData, formatLabel, truncateLabel } from "./utils";

// ============================================================================
// Option Builder Types
// ============================================================================

export interface OptionBuilderContext {
  xData: (string | number)[];
  yDataMap: Record<string, (string | number)[]>;
  yFields: string[];
  colors: string[];
  title?: string;
  showLegend: boolean;
}

export interface CartesianContext extends OptionBuilderContext {
  chartType: ChartType;
  isTimeSeries: boolean;
  stacked: boolean;
  smooth: boolean;
  showSymbol: boolean;
  symbolSize: number;
}

// ============================================================================
// Base Option Builder
// ============================================================================

function buildBaseOption(ctx: OptionBuilderContext): Record<string, unknown> {
  return {
    title: ctx.title ? { text: ctx.title, left: "center" } : undefined,
    color: ctx.colors,
  };
}

// ============================================================================
// Radar Chart Option
// ============================================================================

export function buildRadarOption(
  ctx: OptionBuilderContext,
  showArea = true,
): Record<string, unknown> {
  const maxValue = Math.max(
    ...ctx.yFields.flatMap((f) => ctx.yDataMap[f].map((v) => Number(v) || 0)),
  );

  return {
    ...buildBaseOption(ctx),
    tooltip: { trigger: "item" },
    legend:
      ctx.showLegend && ctx.yFields.length > 1 ? { top: "bottom" } : undefined,
    radar: {
      indicator: ctx.xData.map((name) => ({
        name: String(name),
        max: maxValue * 1.2,
      })),
      shape: "polygon",
    },
    series: [
      {
        type: "radar",
        data: ctx.yFields.map((key, idx) => ({
          name: formatLabel(key),
          value: ctx.yDataMap[key],
          itemStyle: { color: ctx.colors[idx % ctx.colors.length] },
          areaStyle: showArea ? { opacity: 0.3 } : undefined,
        })),
      },
    ],
  };
}

// ============================================================================
// Pie/Donut Chart Option
// ============================================================================

export function buildPieOption(
  ctx: OptionBuilderContext,
  chartType: "pie" | "donut",
  innerRadius: number,
  showLabels: boolean,
  labelPosition: string,
): Record<string, unknown> {
  const pieData = ctx.xData.map((name, i) => ({
    name: String(name),
    value: ctx.yDataMap[ctx.yFields[0]]?.[i] ?? 0,
  }));

  const isDonut = chartType === "donut" || innerRadius > 0;

  return {
    ...buildBaseOption(ctx),
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
    legend: ctx.showLegend
      ? { orient: "vertical", left: "left", top: "middle" }
      : undefined,
    series: [
      {
        type: "pie",
        radius: isDonut ? [`${innerRadius || 40}%`, "70%"] : "70%",
        center: ["60%", "50%"],
        data: pieData,
        label: {
          show: showLabels,
          position: labelPosition,
          formatter: "{b}: {d}%",
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowOffsetX: 0,
            shadowColor: "rgba(0, 0, 0, 0.5)",
          },
        },
      },
    ],
  };
}

// ============================================================================
// Horizontal Bar Chart Option
// ============================================================================

export function buildHorizontalBarOption(
  ctx: OptionBuilderContext,
  stacked: boolean,
): Record<string, unknown> {
  const hasMultipleSeries = ctx.yFields.length > 1;

  return {
    ...buildBaseOption(ctx),
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: ctx.showLegend && hasMultipleSeries ? { top: "bottom" } : undefined,
    grid: {
      left: "20%",
      right: "10%",
      top: ctx.title ? "15%" : "5%",
      bottom: ctx.showLegend && hasMultipleSeries ? "15%" : "5%",
    },
    xAxis: { type: "value" },
    yAxis: {
      type: "category",
      data: ctx.xData,
      axisLabel: {
        width: 100,
        overflow: "truncate",
        formatter: (value: string) => truncateLabel(String(value)),
      },
    },
    series: ctx.yFields.map((key, idx) => ({
      name: formatLabel(key),
      type: "bar",
      data: ctx.yDataMap[key],
      stack: stacked ? "total" : undefined,
      itemStyle: { borderRadius: [0, 4, 4, 0] },
      color: ctx.colors[idx % ctx.colors.length],
    })),
  };
}

// ============================================================================
// Heatmap Chart Option
// ============================================================================

export interface HeatmapContext extends OptionBuilderContext {
  /** Y-axis categories (rows) */
  yAxisData: (string | number)[];
  /** Heatmap data as [xIndex, yIndex, value] tuples */
  heatmapData: [number, number, number][];
  /** Min value for color scale */
  min: number;
  /** Max value for color scale */
  max: number;
  /** Show value labels on cells */
  showLabels: boolean;
}

export function buildHeatmapOption(
  ctx: HeatmapContext,
): Record<string, unknown> {
  return {
    ...buildBaseOption(ctx),
    tooltip: {
      trigger: "item",
      formatter: (params: { data: [number, number, number] }) => {
        const [xIdx, yIdx, value] = params.data;
        const xLabel = ctx.xData[xIdx] ?? xIdx;
        const yLabel = ctx.yAxisData[yIdx] ?? yIdx;
        return `${xLabel}, ${yLabel}: ${value}`;
      },
    },
    grid: {
      left: "15%",
      right: "15%",
      top: ctx.title ? "15%" : "10%",
      bottom: "15%",
    },
    xAxis: {
      type: "category",
      data: ctx.xData,
      splitArea: { show: true },
      axisLabel: {
        rotate: ctx.xData.length > 10 ? 45 : 0,
        formatter: (v: string) => truncateLabel(String(v), 10),
      },
    },
    yAxis: {
      type: "category",
      data: ctx.yAxisData,
      splitArea: { show: true },
      axisLabel: {
        formatter: (v: string) => truncateLabel(String(v), 12),
      },
    },
    visualMap: {
      min: ctx.min,
      max: ctx.max,
      calculable: true,
      orient: "vertical",
      right: "2%",
      top: "center",
      inRange: {
        color: ctx.colors.length >= 2 ? ctx.colors : ["#f0f0f0", ctx.colors[0]],
      },
    },
    series: [
      {
        type: "heatmap",
        data: ctx.heatmapData,
        label: {
          show: ctx.showLabels,
          formatter: (params: { data: [number, number, number] }) =>
            String(params.data[2]),
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowColor: "rgba(0, 0, 0, 0.5)",
          },
        },
      },
    ],
  };
}

// ============================================================================
// Cartesian Chart Option (line, bar, area, scatter)
// ============================================================================

export function buildCartesianOption(
  ctx: CartesianContext,
): Record<string, unknown> {
  const { chartType, isTimeSeries, stacked, smooth, showSymbol, symbolSize } =
    ctx;
  const hasMultipleSeries = ctx.yFields.length > 1;
  const seriesType = chartType === "area" ? "line" : chartType;

  return {
    ...buildBaseOption(ctx),
    tooltip: { trigger: "axis" },
    legend: ctx.showLegend && hasMultipleSeries ? { top: "bottom" } : undefined,
    grid: {
      left: "10%",
      right: "10%",
      top: ctx.title ? "15%" : "10%",
      bottom: ctx.showLegend && hasMultipleSeries ? "20%" : "15%",
    },
    xAxis: {
      type: isTimeSeries ? "time" : "category",
      data: isTimeSeries ? undefined : ctx.xData,
      axisLabel: isTimeSeries
        ? undefined
        : {
            rotate: ctx.xData.length > 10 ? 45 : 0,
            formatter: (v: string) => truncateLabel(String(v), 10),
          },
    },
    yAxis: { type: "value" },
    series: ctx.yFields.map((key, idx) => ({
      name: formatLabel(key),
      type: seriesType,
      data: isTimeSeries
        ? createTimeSeriesData(ctx.xData, ctx.yDataMap[key])
        : ctx.yDataMap[key],
      smooth: chartType === "line" || chartType === "area" ? smooth : undefined,
      showSymbol:
        chartType === "line" || chartType === "area" ? showSymbol : undefined,
      symbol: chartType === "scatter" ? "circle" : undefined,
      symbolSize: chartType === "scatter" ? symbolSize : undefined,
      areaStyle: chartType === "area" ? { opacity: 0.3 } : undefined,
      stack: stacked && chartType === "area" ? "total" : undefined,
      itemStyle:
        chartType === "bar" ? { borderRadius: [4, 4, 0, 0] } : undefined,
      color: ctx.colors[idx % ctx.colors.length],
    })),
  };
}
