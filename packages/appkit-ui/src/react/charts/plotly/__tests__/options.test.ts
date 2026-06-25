import { describe, expect, test } from "vitest";
import { FALLBACK_UI_TOKENS } from "../../constants";
import {
  buildPlotlyCartesian,
  buildPlotlyHeatmap,
  buildPlotlyPie,
  buildPlotlyRadar,
  type PlotlyContext,
} from "../options";

const COLORS = ["#111111", "#222222", "#333333"];

function baseCtx(overrides: Partial<PlotlyContext> = {}): PlotlyContext {
  return {
    xData: ["Jan", "Feb", "Mar"],
    yDataMap: { revenue: [10, 20, 30], cost: [5, 6, 7] },
    yFields: ["revenue", "cost"],
    colors: COLORS,
    showLegend: true,
    ui: FALLBACK_UI_TOKENS,
    ...overrides,
  };
}

// Plotly traces are a strict union; read fields loosely in assertions.
type AnyTrace = Record<string, unknown>;
type AnyLayout = Record<string, unknown>;

describe("buildPlotlyCartesian", () => {
  test("vertical bar: one trace per yField with x=categories, y=values", () => {
    const { traces, layout } = buildPlotlyCartesian({
      ...baseCtx(),
      chartType: "bar",
      orientation: "vertical",
      stacked: false,
      smooth: true,
      showSymbol: false,
      symbolSize: 8,
    });

    expect(traces).toHaveLength(2);
    const t0 = traces[0] as AnyTrace;
    expect(t0.type).toBe("bar");
    expect(t0.name).toBe("Revenue");
    expect(t0.x).toEqual(["Jan", "Feb", "Mar"]);
    expect(t0.y).toEqual([10, 20, 30]);
    expect((layout as AnyLayout).barmode).toBe("group");
  });

  test("horizontal bar swaps axes and sets orientation", () => {
    const { traces } = buildPlotlyCartesian({
      ...baseCtx(),
      chartType: "bar",
      orientation: "horizontal",
      stacked: false,
      smooth: true,
      showSymbol: false,
      symbolSize: 8,
    });

    const t0 = traces[0] as AnyTrace;
    expect(t0.orientation).toBe("h");
    expect(t0.x).toEqual([10, 20, 30]);
    expect(t0.y).toEqual(["Jan", "Feb", "Mar"]);
  });

  test("stacked bar sets barmode stack", () => {
    const { layout } = buildPlotlyCartesian({
      ...baseCtx(),
      chartType: "bar",
      orientation: "vertical",
      stacked: true,
      smooth: true,
      showSymbol: false,
      symbolSize: 8,
    });
    expect((layout as AnyLayout).barmode).toBe("stack");
  });

  test("line: scatter trace, spline when smooth, lines+markers when showSymbol", () => {
    const { traces } = buildPlotlyCartesian({
      ...baseCtx({ yFields: ["revenue"], yDataMap: { revenue: [1, 2, 3] } }),
      chartType: "line",
      orientation: "vertical",
      stacked: false,
      smooth: true,
      showSymbol: true,
      symbolSize: 8,
    });
    const t0 = traces[0] as AnyTrace;
    expect(t0.type).toBe("scatter");
    expect(t0.mode).toBe("lines+markers");
    expect((t0.line as AnyTrace).shape).toBe("spline");
  });

  test("line: linear shape when smooth is false", () => {
    const { traces } = buildPlotlyCartesian({
      ...baseCtx({ yFields: ["revenue"], yDataMap: { revenue: [1, 2, 3] } }),
      chartType: "line",
      orientation: "vertical",
      stacked: false,
      smooth: false,
      showSymbol: false,
      symbolSize: 8,
    });
    const t0 = traces[0] as AnyTrace;
    expect(t0.mode).toBe("lines");
    expect((t0.line as AnyTrace).shape).toBe("linear");
  });

  test("area: fill tozeroy when not stacked, stackgroup when stacked", () => {
    const single = baseCtx({
      yFields: ["revenue"],
      yDataMap: { revenue: [1, 2, 3] },
    });
    const unstacked = buildPlotlyCartesian({
      ...single,
      chartType: "area",
      orientation: "vertical",
      stacked: false,
      smooth: true,
      showSymbol: false,
      symbolSize: 8,
    });
    expect((unstacked.traces[0] as AnyTrace).fill).toBe("tozeroy");

    const stacked = buildPlotlyCartesian({
      ...single,
      chartType: "area",
      orientation: "vertical",
      stacked: true,
      smooth: true,
      showSymbol: false,
      symbolSize: 8,
    });
    expect((stacked.traces[0] as AnyTrace).stackgroup).toBe("one");
  });

  test("scatter: markers mode with symbolSize", () => {
    const { traces } = buildPlotlyCartesian({
      ...baseCtx({ yFields: ["revenue"], yDataMap: { revenue: [1, 2, 3] } }),
      chartType: "scatter",
      orientation: "vertical",
      stacked: false,
      smooth: true,
      showSymbol: false,
      symbolSize: 12,
    });
    const t0 = traces[0] as AnyTrace;
    expect(t0.mode).toBe("markers");
    expect((t0.marker as AnyTrace).size).toBe(12);
  });

  test("layout carries theme tokens (transparent bg, colorway, font color)", () => {
    const { layout } = buildPlotlyCartesian({
      ...baseCtx(),
      chartType: "bar",
      orientation: "vertical",
      stacked: false,
      smooth: true,
      showSymbol: false,
      symbolSize: 8,
    });
    const l = layout as AnyLayout;
    expect(l.paper_bgcolor).toBe("rgba(0,0,0,0)");
    expect(l.plot_bgcolor).toBe("rgba(0,0,0,0)");
    expect(l.colorway).toEqual(COLORS);
    expect((l.font as AnyTrace).color).toBe(FALLBACK_UI_TOKENS.axisTitle);
  });
});

describe("buildPlotlyPie", () => {
  test("pie has hole 0; labels and values from first yField", () => {
    const { traces } = buildPlotlyPie(baseCtx(), false, 0, true, "outside");
    const t0 = traces[0] as AnyTrace;
    expect(t0.type).toBe("pie");
    expect(t0.hole).toBe(0);
    expect(t0.labels).toEqual(["Jan", "Feb", "Mar"]);
    expect(t0.values).toEqual([10, 20, 30]);
  });

  test("donut sets a non-zero hole", () => {
    const { traces } = buildPlotlyPie(baseCtx(), true, 50, true, "outside");
    expect((traces[0] as AnyTrace).hole).toBe(0.5);
  });

  test("center label position maps to inside", () => {
    const { traces } = buildPlotlyPie(baseCtx(), false, 0, true, "center");
    expect((traces[0] as AnyTrace).textposition).toBe("inside");
  });
});

describe("buildPlotlyRadar", () => {
  test("emits scatterpolar traces with fill and polar layout", () => {
    const { traces, layout } = buildPlotlyRadar(baseCtx(), true);
    const t0 = traces[0] as AnyTrace;
    expect(t0.type).toBe("scatterpolar");
    expect(t0.fill).toBe("toself");
    expect(t0.theta).toEqual(["Jan", "Feb", "Mar"]);
    expect((layout as AnyLayout).polar).toBeDefined();
  });

  test("fill none when showArea is false", () => {
    const { traces } = buildPlotlyRadar(baseCtx(), false);
    expect((traces[0] as AnyTrace).fill).toBe("none");
  });
});

describe("buildPlotlyHeatmap", () => {
  test("builds a dense z-matrix from sparse [x, y, value] tuples", () => {
    const { traces } = buildPlotlyHeatmap({
      ...baseCtx({ xData: ["A", "B"], yFields: [], yDataMap: {} }),
      yAxisData: ["row1", "row2"],
      // [xIndex, yIndex, value]
      heatmapData: [
        [0, 0, 1],
        [1, 0, 2],
        [0, 1, 3],
        [1, 1, 4],
      ],
      min: 1,
      max: 4,
      showLabels: false,
    });
    const t0 = traces[0] as AnyTrace;
    expect(t0.type).toBe("heatmap");
    expect(t0.z).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(t0.x).toEqual(["A", "B"]);
    expect(t0.y).toEqual(["row1", "row2"]);
    expect(Array.isArray(t0.colorscale)).toBe(true);
  });
});
