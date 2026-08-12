import { FALLBACK_UI_TOKENS } from "./constants";
import type { ChartType, ChartUITokens, ChartValueFormatter } from "./types";
import {
  createTimeSeriesData,
  escapeHtml,
  formatLabel,
  truncateLabel,
} from "./utils";

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
  valueFormatter?: ChartValueFormatter;
}

export interface CartesianContext extends OptionBuilderContext {
  chartType: ChartType;
  isTimeSeries: boolean;
  stacked: boolean;
  smooth: boolean;
  showSymbol: boolean;
  symbolSize: number;
  /**
   * Whether a click handler is attached. When true, line/area series set
   * `triggerLineEvent` so a click anywhere on the stroke fires (not just on a
   * symbol) — otherwise clicking a thin line is nearly impossible to land.
   */
  interactive?: boolean;
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

/**
 * ECharts passes tuple-backed series (time-series, scatter, heatmap) to tooltip
 * value formatters as the whole tuple. The measure is always the final entry.
 */
function toMeasureValue(value: unknown): string | number {
  const scalar = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof scalar === "string" || typeof scalar === "number") return scalar;
  return scalar == null ? "" : String(scalar);
}

function tooltipValueFormatter(formatter: ChartValueFormatter, field: string) {
  return (value: unknown) => formatter(toMeasureValue(value), field);
}

function valueAxisLabel(ctx: OptionBuilderContext) {
  const field = ctx.yFields[0];
  const formatter = ctx.valueFormatter;
  return formatter && field
    ? { formatter: (value: string | number) => formatter(value, field) }
    : {};
}

// ============================================================================
// Radar Chart Option
// ============================================================================

export function buildRadarOption(
  ctx: OptionBuilderContext,
  showArea = true,
): Record<string, unknown> {
  const ui = ctx.ui ?? FALLBACK_UI_TOKENS;
  const formatter = ctx.valueFormatter;
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
          tooltip: formatter
            ? {
                valueFormatter: (value: unknown) => {
                  const values = Array.isArray(value) ? value : [value];
                  return values
                    .map((item) => formatter(toMeasureValue(item), key))
                    .join(", ");
                },
              }
            : undefined,
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
  const valueField = ctx.yFields[0];
  const formatter = ctx.valueFormatter;

  return {
    ...buildBaseOption(ctx),
    tooltip: {
      ...tooltipTokens(ui),
      trigger: "item",
      formatter:
        formatter && valueField
          ? (params: {
              name: string;
              value: string | number;
              percent: number;
            }) =>
              `${escapeHtml(String(params.name))}: ${escapeHtml(
                formatter(params.value, valueField),
              )} (${params.percent}%)`
          : "{b}: {c} ({d}%)",
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
        // Keep very small categories pointer-selectable. ECharts still reports
        // labels/tooltips from the true values, while a three-degree sector is
        // wide enough to survive CSS-pixel rounding on typical card sizes.
        minAngle: 3,
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
    xAxis: { type: "value", ...mergeAxisLabel(ui, valueAxisLabel(ctx)) },
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
      tooltip: ctx.valueFormatter
        ? {
            valueFormatter: tooltipValueFormatter(ctx.valueFormatter, key),
          }
        : undefined,
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
  const valueField = ctx.yFields[0];
  const formatter = ctx.valueFormatter;
  const formatHeatmapValue = (value: number) =>
    formatter && valueField ? formatter(value, valueField) : String(value);
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
        return `${xLabel}, ${yLabel}: ${escapeHtml(formatHeatmapValue(value))}`;
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
      formatter:
        formatter && valueField
          ? (value: number) => formatter(value, valueField)
          : undefined,
      inRange: {
        // A visualMap gradient needs at least two stops; with a single-color
        // palette, ramp from a light grey to that color instead of passing a
        // one-entry array (which ECharts renders as a flat, unreadable scale).
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
            formatHeatmapValue(params.data[2]),
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
  const {
    chartType,
    isTimeSeries,
    stacked,
    smooth,
    showSymbol,
    symbolSize,
    interactive,
  } = ctx;
  const hasMultipleSeries = ctx.yFields.length > 1;
  const seriesType = chartType === "area" ? "line" : chartType;
  const isScatter = chartType === "scatter";
  const isLineLike = chartType === "line" || chartType === "area";

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
      ...mergeAxisLabel(ui, valueAxisLabel(ctx)),
    },
    series: ctx.yFields.map((key, idx) => ({
      name: formatLabel(key),
      type: seriesType,
      data: isScatter
        ? ctx.xData.map((x, i) => [x, ctx.yDataMap[key][i]])
        : isTimeSeries
          ? createTimeSeriesData(ctx.xData, ctx.yDataMap[key])
          : ctx.yDataMap[key],
      smooth: isLineLike ? smooth : undefined,
      showSymbol: isLineLike ? showSymbol : undefined,
      symbol: isScatter ? "circle" : undefined,
      // Symbol size applies to line/area as well as scatter, so an interactive
      // line can present a clickable point, not just a hairline.
      symbolSize: isScatter || isLineLike ? symbolSize : undefined,
      // Fire click events along the whole line stroke, not only on symbols,
      // when the chart is interactive. No effect on non-line series.
      triggerLineEvent: isLineLike && interactive ? true : undefined,
      areaStyle: chartType === "area" ? { opacity: 0.3 } : undefined,
      stack: stacked && chartType === "area" ? "total" : undefined,
      itemStyle:
        chartType === "bar" ? { borderRadius: [4, 4, 0, 0] } : undefined,
      color: ctx.colors[idx % ctx.colors.length],
      tooltip: ctx.valueFormatter
        ? {
            valueFormatter: tooltipValueFormatter(ctx.valueFormatter, key),
          }
        : undefined,
    })),
  };
}

// ============================================================================
// Selection Emphasis (declarative cross-filter highlighting)
// ============================================================================

// Selection opacity stays local because it is not a theme token.
const DIMMED_OPACITY = 0.3;

/** Opacity applied to selected (emphasized) data elements. */
const SELECTED_OPACITY = 1;

/** Options controlling {@link applySelectionEmphasis}. */
interface SelectionEmphasisOptions {
  /** Opacity for dimmed (non-selected) elements. @default 0.3 */
  dimmedOpacity?: number;
  /** Opacity for emphasized (selected) elements. @default 1 */
  selectedOpacity?: number;
}

/**
 * Returns selected category names, or `null` when empty.
 */
function toSelectionSet(
  selected: string | string[] | undefined,
): Set<string> | null {
  if (selected == null) return null;
  const names = Array.isArray(selected) ? selected : [selected];
  const set = new Set(
    names.map((name) => String(name)).filter((name) => name !== ""),
  );
  return set.size > 0 ? set : null;
}

/**
 * Finds category-axis labels used to map bar positions to names.
 * Built-in chart options expose at most one category axis.
 * Horizontal and vertical bars put that category on different axes.
 */
function categoryNamesFromAxes(
  option: Record<string, unknown>,
): (string | number)[] | null {
  for (const axisKey of ["xAxis", "yAxis"] as const) {
    const axis = option[axisKey];
    if (axis !== null && typeof axis === "object" && !Array.isArray(axis)) {
      const a = axis as Record<string, unknown>;
      if (a.type === "category" && Array.isArray(a.data)) {
        return a.data as (string | number)[];
      }
    }
  }
  return null;
}

/**
 * Returns a copy of a single data item with its `itemStyle.opacity` set.
 * Object data items (e.g. pie `{ name, value }`) are spread and their existing
 * `itemStyle` preserved; primitive data items (e.g. raw bar values) are wrapped
 * into `{ value, itemStyle }`.
 * per-datum `itemStyle` merges over the series-level `itemStyle` in ECharts, so
 * styling such as bar `borderRadius` is retained.
 */
function withDatumOpacity(datum: unknown, opacity: number): unknown {
  if (datum !== null && typeof datum === "object" && !Array.isArray(datum)) {
    const d = datum as Record<string, unknown>;
    const prev =
      d.itemStyle !== null &&
      typeof d.itemStyle === "object" &&
      !Array.isArray(d.itemStyle)
        ? (d.itemStyle as Record<string, unknown>)
        : {};
    return { ...d, itemStyle: { ...prev, opacity } };
  }
  return { value: datum as number | string, itemStyle: { opacity } };
}

/**
 * Applies opacity to pie/bar categories.
 */
function emphasizeSeries(
  series: unknown,
  selected: Set<string>,
  dimmedOpacity: number,
  selectedOpacity: number,
  categoryNames: (string | number)[] | null,
): unknown {
  if (series === null || typeof series !== "object" || Array.isArray(series)) {
    return series;
  }
  const s = series as Record<string, unknown>;
  if (!Array.isArray(s.data)) return series;

  let nameAt: (datum: unknown, index: number) => string | undefined;
  if (s.type === "pie") {
    nameAt = (datum) =>
      datum !== null && typeof datum === "object" && "name" in datum
        ? String((datum as Record<string, unknown>).name)
        : undefined;
  } else if (s.type === "bar") {
    // Bar data items are raw values; the category name lives on the category axis.
    if (!categoryNames) return series;
    nameAt = (_datum, index) =>
      categoryNames[index] !== undefined
        ? String(categoryNames[index])
        : undefined;
  } else {
    return series;
  }

  const data = (s.data as unknown[]).map((datum, index) => {
    const name = nameAt(datum, index);
    if (name === undefined) return datum;
    const opacity = selected.has(name) ? selectedOpacity : dimmedOpacity;
    return withDatumOpacity(datum, opacity);
  });

  return { ...s, data };
}

/**
 * Pure, declarative selection-emphasis transform for a built ECharts `option`.
 *
 * Given one or more selected category names, returns a new `option` in which the
 * matching data element(s) render at full prominence while the rest are dimmed
 * via `itemStyle.opacity`. It is a **no-op** (returns the input unchanged) when
 * `selected` is `undefined` or empty.
 *
 * @typeParam T - The option object type (typically `Record<string, unknown>`).
 * @param option - The ECharts option produced by one of the `build*Option` helpers.
 * @param selected - The selected category name(s); `undefined`/empty means no emphasis.
 * @param opts - Optional opacity overrides. See {@link SelectionEmphasisOptions}.
 * @returns A new option with emphasis applied, or the original `option` when there is no selection.
 */
export function applySelectionEmphasis<T>(
  option: T,
  selected: string | string[] | undefined,
  opts: SelectionEmphasisOptions = {},
): T {
  const selectedSet = toSelectionSet(selected);
  if (!selectedSet) return option;

  if (option === null || typeof option !== "object" || Array.isArray(option)) {
    return option;
  }
  const opt = option as Record<string, unknown>;
  if (!Array.isArray(opt.series)) return option;

  const dimmedOpacity = opts.dimmedOpacity ?? DIMMED_OPACITY;
  const selectedOpacity = opts.selectedOpacity ?? SELECTED_OPACITY;
  const categoryNames = categoryNamesFromAxes(opt);

  const series = (opt.series as unknown[]).map((s) =>
    emphasizeSeries(
      s,
      selectedSet,
      dimmedOpacity,
      selectedOpacity,
      categoryNames,
    ),
  );

  return { ...opt, series } as T;
}
