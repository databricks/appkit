import { FALLBACK_UI_TOKENS } from "../constants";
import type { ChartType, ChartUITokens } from "../types";
import {
  createTimeSeriesData,
  escapeHtml,
  formatLabel,
  truncateLabel,
} from "../utils";

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
  xField?: string;
  ui?: ChartUITokens;
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
  const ui = ctx.ui ?? FALLBACK_UI_TOKENS;
  return {
    title: ctx.title
      ? {
          text: ctx.title,
          left: "center",
          textStyle: { color: ui.axisTitle },
        }
      : undefined,
    color: ctx.colors,
  };
}

function axisCommon(ui: ChartUITokens) {
  return {
    axisLabel: { color: ui.axisLabel },
    axisLine: { lineStyle: { color: ui.grid } },
    axisTick: { lineStyle: { color: ui.grid } },
    splitLine: { lineStyle: { color: ui.grid } },
    nameTextStyle: { color: ui.axisTitle },
  };
}

function mergeAxisLabel(
  ui: ChartUITokens,
  axisLabel: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...axisCommon(ui),
    axisLabel: { color: ui.axisLabel, ...axisLabel },
  };
}

function legendTextStyle(ui: ChartUITokens) {
  return { textStyle: { color: ui.axisTitle } };
}

function tooltipTokens(ui: ChartUITokens) {
  return {
    backgroundColor: ui.tooltipBg,
    borderColor: ui.grid,
    textStyle: { color: ui.axisTitle },
  };
}

// ============================================================================
// Radar Chart Option
// ============================================================================

export function buildRadarOption(
  ctx: OptionBuilderContext,
  showArea = true,
): Record<string, unknown> {
  const ui = ctx.ui ?? FALLBACK_UI_TOKENS;
  const maxValue = Math.max(
    ...ctx.yFields.flatMap((f) => ctx.yDataMap[f].map((v) => Number(v) || 0)),
  );

  return {
    ...buildBaseOption(ctx),
    tooltip: { ...tooltipTokens(ui), trigger: "item" },
    legend:
      ctx.showLegend && ctx.yFields.length > 1
        ? { top: "bottom", ...legendTextStyle(ui) }
        : undefined,
    radar: {
      indicator: ctx.xData.map((name) => ({
        name: String(name),
        max: maxValue * 1.2,
      })),
      shape: "polygon",
      axisName: { color: ui.axisTitle },
      axisLine: { lineStyle: { color: ui.grid } },
      splitLine: { lineStyle: { color: ui.grid } },
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
  const ui = ctx.ui ?? FALLBACK_UI_TOKENS;
  const pieData = ctx.xData.map((name, i) => ({
    name: String(name),
    value: ctx.yDataMap[ctx.yFields[0]]?.[i] ?? 0,
  }));

  const isDonut = chartType === "donut" || innerRadius > 0;

  return {
    ...buildBaseOption(ctx),
    tooltip: {
      ...tooltipTokens(ui),
      trigger: "item",
      formatter: "{b}: {c} ({d}%)",
    },
    legend: ctx.showLegend
      ? {
          orient: "vertical",
          left: "left",
          top: "middle",
          ...legendTextStyle(ui),
        }
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
          color: "inherit",
          textBorderWidth: 0,
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
  const ui = ctx.ui ?? FALLBACK_UI_TOKENS;
  const hasMultipleSeries = ctx.yFields.length > 1;

  return {
    ...buildBaseOption(ctx),
    tooltip: {
      ...tooltipTokens(ui),
      trigger: "axis",
      axisPointer: { type: "shadow" },
    },
    legend:
      ctx.showLegend && hasMultipleSeries
        ? { top: "bottom", ...legendTextStyle(ui) }
        : undefined,
    grid: {
      left: "20%",
      right: "10%",
      top: ctx.title ? "15%" : "5%",
      bottom: ctx.showLegend && hasMultipleSeries ? "15%" : "5%",
    },
    xAxis: { type: "value", ...axisCommon(ui) },
    yAxis: {
      type: "category",
      data: ctx.xData,
      ...mergeAxisLabel(ui, {
        width: 100,
        overflow: "truncate",
        formatter: (value: string) => truncateLabel(String(value)),
      }),
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
  const ui = ctx.ui ?? FALLBACK_UI_TOKENS;
  return {
    ...buildBaseOption(ctx),
    tooltip: {
      ...tooltipTokens(ui),
      trigger: "item",
      formatter: (params: { data: [number, number, number] }) => {
        const [xIdx, yIdx, value] = params.data;
        // Function formatter output is injected as raw HTML into the
        // tooltip DOM, so data-derived labels must be escaped.
        const xLabel = escapeHtml(String(ctx.xData[xIdx] ?? xIdx));
        const yLabel = escapeHtml(String(ctx.yAxisData[yIdx] ?? yIdx));
        return `${xLabel}, ${yLabel}: ${escapeHtml(String(value))}`;
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
      ...mergeAxisLabel(ui, {
        rotate: ctx.xData.length > 10 ? 45 : 0,
        formatter: (v: string) => truncateLabel(String(v), 10),
      }),
    },
    yAxis: {
      type: "category",
      data: ctx.yAxisData,
      splitArea: { show: true },
      ...mergeAxisLabel(ui, {
        formatter: (v: string) => truncateLabel(String(v), 12),
      }),
    },
    visualMap: {
      min: ctx.min,
      max: ctx.max,
      calculable: true,
      orient: "vertical",
      right: "2%",
      top: "center",
      textStyle: { color: ui.axisTitle },
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
  const ui = ctx.ui ?? FALLBACK_UI_TOKENS;
  const { chartType, isTimeSeries, stacked, smooth, showSymbol, symbolSize } =
    ctx;
  const hasMultipleSeries = ctx.yFields.length > 1;
  const seriesType = chartType === "area" ? "line" : chartType;
  const isScatter = chartType === "scatter";

  return {
    ...buildBaseOption(ctx),
    tooltip: { ...tooltipTokens(ui), trigger: isScatter ? "item" : "axis" },
    legend:
      ctx.showLegend && hasMultipleSeries
        ? { top: "bottom", ...legendTextStyle(ui) }
        : undefined,
    grid: {
      left: "10%",
      right: "10%",
      top: ctx.title ? "15%" : "10%",
      bottom: ctx.showLegend && hasMultipleSeries ? "20%" : "15%",
      containLabel: true,
    },
    xAxis: {
      type: isScatter ? "value" : isTimeSeries ? "time" : "category",
      data: isScatter || isTimeSeries ? undefined : ctx.xData,
      name: ctx.xField ? formatLabel(ctx.xField) : undefined,
      ...mergeAxisLabel(
        ui,
        isScatter || isTimeSeries
          ? { show: true }
          : {
              rotate: ctx.xData.length > 10 ? 45 : 0,
              formatter: (v: string) => truncateLabel(String(v), 10),
            },
      ),
    },
    yAxis: {
      type: "value",
      name: ctx.yFields.length === 1 ? formatLabel(ctx.yFields[0]) : undefined,
      ...axisCommon(ui),
    },
    series: ctx.yFields.map((key, idx) => ({
      name: formatLabel(key),
      type: seriesType,
      data: isScatter
        ? ctx.xData.map((x, i) => [x, ctx.yDataMap[key][i]])
        : isTimeSeries
          ? createTimeSeriesData(ctx.xData, ctx.yDataMap[key])
          : ctx.yDataMap[key],
      smooth: chartType === "line" || chartType === "area" ? smooth : undefined,
      showSymbol:
        chartType === "line" || chartType === "area" ? showSymbol : undefined,
      // Line/area markers default to tiny size-4 hollow circles, which makes an
      // enabled `showSymbol` barely visible. Use a filled circle at the shared
      // symbol size so opted-in markers actually read.
      symbol:
        isScatter || chartType === "line" || chartType === "area"
          ? "circle"
          : undefined,
      symbolSize:
        isScatter || chartType === "line" || chartType === "area"
          ? symbolSize
          : undefined,
      areaStyle: chartType === "area" ? { opacity: 0.3 } : undefined,
      stack:
        stacked && (chartType === "area" || chartType === "bar")
          ? "total"
          : undefined,
      itemStyle:
        chartType === "bar" ? { borderRadius: [4, 4, 0, 0] } : undefined,
      color: ctx.colors[idx % ctx.colors.length],
    })),
  };
}
