import type { Data, Layout } from "plotly.js";
import type { ChartType, ChartUITokens } from "../types";
import { formatLabel } from "../utils";

// ============================================================================
// Plotly Option Builders
// ============================================================================
//
// These mirror the ECharts builders in `../options.ts`, but emit Plotly
// `{ traces, layout }` instead of an ECharts option object. They consume the
// same engine-agnostic normalized data (`xData` / `yFields` / `yDataMap`) and
// the same theme tokens, so the Plotly charts stay visually consistent with the
// ECharts charts and honor AppKit light/dark mode.

/** Shared context for the Plotly builders (parallels `OptionBuilderContext`). */
export interface PlotlyContext {
  xData: (string | number)[];
  yDataMap: Record<string, (string | number)[]>;
  yFields: string[];
  colors: string[];
  title?: string;
  showLegend: boolean;
  xField?: string;
  ui: ChartUITokens;
}

export interface PlotlyCartesianContext extends PlotlyContext {
  chartType: ChartType;
  orientation: "vertical" | "horizontal";
  stacked: boolean;
  smooth: boolean;
  showSymbol: boolean;
  symbolSize: number;
}

export interface PlotlyHeatmapContext extends PlotlyContext {
  yAxisData: (string | number)[];
  heatmapData: [number, number, number][];
  min: number;
  max: number;
  showLabels: boolean;
}

/** The output of every builder: traces + a layout to merge. */
export interface PlotlyFigure {
  traces: Data[];
  layout: Partial<Layout>;
}

// ============================================================================
// Shared Layout
// ============================================================================

/**
 * Builds the theme-aware base layout shared by all Plotly charts. Backgrounds
 * are transparent so the chart inherits the surrounding card/page surface, and
 * fonts/grids follow the resolved AppKit UI tokens.
 */
function baseLayout(ctx: PlotlyContext): Partial<Layout> {
  const { ui } = ctx;
  return {
    autosize: true,
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    colorway: ctx.colors,
    font: { color: ui.axisTitle },
    margin: { t: ctx.title ? 48 : 16, r: 16, b: 48, l: 56 },
    title: ctx.title ? { text: ctx.title, x: 0.5 } : undefined,
    showlegend: ctx.showLegend && ctx.yFields.length > 1,
    legend: { orientation: "h", y: -0.2, font: { color: ui.axisTitle } },
    hoverlabel: { bgcolor: ui.tooltipBg, font: { color: ui.axisTitle } },
  };
}

/** Themed cartesian axis defaults. */
function themedAxis(
  ui: ChartUITokens,
  title?: string,
): Partial<Layout["xaxis"]> {
  return {
    title: title ? { text: title, font: { color: ui.axisTitle } } : undefined,
    gridcolor: ui.grid,
    linecolor: ui.grid,
    zerolinecolor: ui.grid,
    tickfont: { color: ui.axisLabel },
  };
}

// ============================================================================
// Cartesian (bar / line / area / scatter)
// ============================================================================

export function buildPlotlyCartesian(
  ctx: PlotlyCartesianContext,
): PlotlyFigure {
  const {
    chartType,
    orientation,
    stacked,
    smooth,
    showSymbol,
    symbolSize,
    xData,
    yFields,
    yDataMap,
  } = ctx;

  const isHorizontal = chartType === "bar" && orientation === "horizontal";
  const categories = xData.map((v) => (typeof v === "number" ? v : String(v)));

  const traces: Data[] = yFields.map((key) => {
    const name = formatLabel(key);
    const values = yDataMap[key];

    if (chartType === "bar") {
      return {
        type: "bar",
        name,
        ...(isHorizontal
          ? { orientation: "h", x: values, y: categories }
          : { x: categories, y: values }),
      } as Data;
    }

    if (chartType === "scatter") {
      return {
        type: "scatter",
        mode: "markers",
        name,
        x: categories,
        y: values,
        marker: { size: symbolSize },
      } as Data;
    }

    // line + area both render as scatter traces
    const isArea = chartType === "area";
    return {
      type: "scatter",
      mode: showSymbol ? "lines+markers" : "lines",
      name,
      x: categories,
      y: values,
      line: { shape: smooth ? "spline" : "linear" },
      ...(isArea
        ? stacked
          ? { stackgroup: "one" }
          : { fill: "tozeroy" }
        : {}),
    } as Data;
  });

  const ui = ctx.ui;
  const layout: Partial<Layout> = {
    ...baseLayout(ctx),
    barmode: stacked ? "stack" : "group",
    xaxis: isHorizontal
      ? themedAxis(ui, undefined)
      : themedAxis(ui, ctx.xField ? formatLabel(ctx.xField) : undefined),
    yaxis: themedAxis(
      ui,
      !isHorizontal && yFields.length === 1
        ? formatLabel(yFields[0])
        : undefined,
    ),
  };

  return { traces, layout };
}

// ============================================================================
// Pie / Donut
// ============================================================================

export function buildPlotlyPie(
  ctx: PlotlyContext,
  isDonut: boolean,
  innerRadius: number,
  showLabels: boolean,
  labelPosition: "outside" | "inside" | "center",
): PlotlyFigure {
  const values = ctx.yDataMap[ctx.yFields[0]] ?? [];
  const hole = isDonut ? (innerRadius || 40) / 100 : 0;
  // Plotly pie supports inside/outside/auto/none — map "center" to "inside".
  const textposition = labelPosition === "center" ? "inside" : labelPosition;

  const traces: Data[] = [
    {
      type: "pie",
      labels: ctx.xData.map(String),
      values,
      hole,
      textposition,
      textinfo: showLabels ? "label+percent" : "none",
      hoverinfo: "label+value+percent",
      marker: { colors: ctx.colors },
    } as Data,
  ];

  const layout: Partial<Layout> = {
    ...baseLayout(ctx),
    showlegend: ctx.showLegend,
  };

  return { traces, layout };
}

// ============================================================================
// Radar (scatterpolar)
// ============================================================================

export function buildPlotlyRadar(
  ctx: PlotlyContext,
  showArea: boolean,
): PlotlyFigure {
  const theta = ctx.xData.map(String);
  const traces: Data[] = ctx.yFields.map((key) => ({
    type: "scatterpolar",
    name: formatLabel(key),
    r: ctx.yDataMap[key],
    theta,
    fill: showArea ? "toself" : "none",
  })) as Data[];

  const maxValue = Math.max(
    0,
    ...ctx.yFields.flatMap((f) => ctx.yDataMap[f].map((v) => Number(v) || 0)),
  );

  const layout: Partial<Layout> = {
    ...baseLayout(ctx),
    showlegend: ctx.showLegend && ctx.yFields.length > 1,
    polar: {
      radialaxis: {
        visible: true,
        range: [0, maxValue * 1.2],
        gridcolor: ctx.ui.grid,
        tickfont: { color: ctx.ui.axisLabel },
      },
      angularaxis: {
        gridcolor: ctx.ui.grid,
        tickfont: { color: ctx.ui.axisTitle },
      },
    },
  };

  return { traces, layout };
}

// ============================================================================
// Heatmap
// ============================================================================

/** Builds a Plotly colorscale (0→1 stops) from the resolved palette colors. */
function toColorscale(colors: string[]): [number, string][] {
  const stops =
    colors.length >= 2 ? colors : ["#f0f0f0", colors[0] ?? "#1f77b4"];
  const last = stops.length - 1;
  return stops.map((color, i) => [last === 0 ? 0 : i / last, color]);
}

export function buildPlotlyHeatmap(ctx: PlotlyHeatmapContext): PlotlyFigure {
  const { xData, yAxisData, heatmapData, min, max, showLabels } = ctx;

  // Build a dense z-matrix [yIndex][xIndex] from the sparse [x, y, value] tuples.
  const z: (number | null)[][] = yAxisData.map(() =>
    xData.map(() => null as number | null),
  );
  for (const [xi, yi, value] of heatmapData) {
    if (z[yi]) z[yi][xi] = value;
  }

  const traces: Data[] = [
    {
      type: "heatmap",
      z,
      x: xData.map(String),
      y: yAxisData.map(String),
      zmin: min,
      zmax: max,
      colorscale: toColorscale(ctx.colors),
      showscale: true,
      ...(showLabels ? { texttemplate: "%{z}" } : {}),
    } as Data,
  ];

  const layout: Partial<Layout> = {
    ...baseLayout(ctx),
    xaxis: { ...themedAxis(ctx.ui), automargin: true },
    yaxis: { ...themedAxis(ctx.ui), automargin: true },
  };

  return { traces, layout };
}
