// ============================================================================
// Plotly Charts (experimental)
// ============================================================================
//
// The Plotly rendering path for AppKit charts. `PlotlyBaseChart` is the engine
// renderer wired into the unified `createChart` factory (select it with
// `engine="plotly"` or `<ChartEngineProvider engine="plotly">`). `PlotlyChart`
// is a generic escape hatch exposing Plotly's full trace API for chart types
// the unified charts don't model (3D, sankey, sunburst, candlestick, …).

export { PlotlyBaseChart, type PlotlyBaseChartProps } from "./base";
// Trace/layout builders (for advanced customization)
export {
  buildPlotlyCartesian,
  buildPlotlyHeatmap,
  buildPlotlyPie,
  buildPlotlyRadar,
  type PlotlyCartesianContext,
  type PlotlyContext,
  type PlotlyFigure,
  type PlotlyHeatmapContext,
} from "./options";
export { PlotlyChart, type PlotlyChartProps } from "./plotly-chart";
export { type PlotlyRow, toRowObjects } from "./rows";
