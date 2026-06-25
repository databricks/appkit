import {
  AreaChart,
  Badge,
  BarChart,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DonutChart,
  HeatmapChart,
  Label,
  LineChart,
  PieChart,
  PlotlyChart,
  RadarChart,
  ScatterChart,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Slider,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
} from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
import type { Data } from "plotly.js";
import { type ReactNode, useState } from "react";
import { Header } from "@/components/layout/header";

export const Route = createFileRoute("/plotly")({
  component: PlotlyRoute,
});

type Palette = "categorical" | "sequential" | "diverging";
type Orientation = "vertical" | "horizontal";

// ============================================================================
// Static demo data (so the page renders without a SQL warehouse)
// ============================================================================

// Multi-series financials in $K.
const REVENUE = [
  { month: "Jan", revenue: 42, cost: 28, profit: 14 },
  { month: "Feb", revenue: 47, cost: 30, profit: 17 },
  { month: "Mar", revenue: 52, cost: 31, profit: 21 },
  { month: "Apr", revenue: 49, cost: 33, profit: 16 },
  { month: "May", revenue: 58, cost: 36, profit: 22 },
  { month: "Jun", revenue: 63, cost: 38, profit: 25 },
  { month: "Jul", revenue: 67, cost: 41, profit: 26 },
  { month: "Aug", revenue: 61, cost: 39, profit: 22 },
  { month: "Sep", revenue: 72, cost: 44, profit: 28 },
  { month: "Oct", revenue: 78, cost: 47, profit: 31 },
  { month: "Nov", revenue: 81, cost: 49, profit: 32 },
  { month: "Dec", revenue: 90, cost: 53, profit: 37 },
];

const TRAFFIC = [
  { source: "Organic", visits: 5400 },
  { source: "Paid", visits: 3100 },
  { source: "Referral", visits: 1800 },
  { source: "Social", visits: 2400 },
  { source: "Email", visits: 1200 },
  { source: "Direct", visits: 3600 },
];

// Daily active users over 30 days (time series).
const DAU = Array.from({ length: 30 }, (_, i) => ({
  date: `2026-06-${String(i + 1).padStart(2, "0")}`,
  users: Math.round(1200 + 350 * Math.sin(i / 3.2) + i * 18),
}));

// Ad spend vs conversions (scatter).
const ADS = Array.from({ length: 60 }, (_, i) => {
  const spend = 80 + i * 22;
  const noise = Math.sin(i * 12.9898) * 43758.5453;
  const jitter = (noise - Math.floor(noise) - 0.5) * 90;
  return {
    spend,
    conversions: Math.max(0, Math.round(spend * 0.42 + jitter)),
  };
});

// Team capability comparison (radar).
const SKILLS = [
  { axis: "Speed", teamA: 80, teamB: 60 },
  { axis: "Reliability", teamA: 70, teamB: 92 },
  { axis: "Cost", teamA: 62, teamB: 75 },
  { axis: "Scale", teamA: 85, teamB: 70 },
  { axis: "DX", teamA: 90, teamB: 65 },
  { axis: "Support", teamA: 66, teamB: 82 },
];

// Weekly activity heatmap: day (row) x hour (column) -> sessions.
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HEATMAP = DAYS.flatMap((day, d) =>
  Array.from({ length: 24 }, (_, hour) => {
    const workday = d < 5;
    const peak = workday ? 11 : 15;
    const base = workday ? 50 : 22;
    const value = Math.round(
      base + 60 * Math.exp(-((hour - peak) ** 2) / 18) + (d % 3) * 6,
    );
    return { day, hour, sessions: value };
  }),
);

// ----- Plotly-only datasets -----

// 3D helix.
const HELIX_3D = Array.from({ length: 160 }, (_, i) => {
  const t = (i / 160) * Math.PI * 6;
  return {
    x: Math.cos(t) * (1 + i / 320),
    y: Math.sin(t) * (1 + i / 320),
    z: i / 14,
  };
});

// 3D surface / contour z-matrix.
const SURFACE_Z = Array.from({ length: 30 }, (_, i) =>
  Array.from(
    { length: 30 },
    (_, j) => Math.sin(i / 3.5) * Math.cos(j / 3.5) * 8 + (i + j) / 8,
  ),
);

// Candlestick OHLC.
const CANDLES = Array.from({ length: 28 }, (_, i) => {
  const base = 100 + i * 1.6 + Math.sin(i / 2) * 6;
  const open = base + Math.sin(i * 1.3) * 3;
  const close = base + Math.cos(i * 0.7) * 3;
  const high = Math.max(open, close) + 2 + (i % 3);
  const low = Math.min(open, close) - 2 - (i % 2);
  return {
    date: `2026-05-${String(i + 1).padStart(2, "0")}`,
    open,
    high,
    low,
    close,
  };
});

// Bubble chart: market segments (x = growth, y = margin, size = revenue).
const BUBBLES = [
  { name: "Enterprise", growth: 12, margin: 38, revenue: 120 },
  { name: "Mid-market", growth: 28, margin: 24, revenue: 80 },
  { name: "SMB", growth: 41, margin: 14, revenue: 45 },
  { name: "Self-serve", growth: 63, margin: 9, revenue: 30 },
  { name: "Education", growth: 18, margin: 6, revenue: 18 },
  { name: "Public sector", growth: 8, margin: 31, revenue: 64 },
];

// Shared org → team hierarchy for sunburst + treemap.
const HIERARCHY = {
  branchvalues: "total" as const,
  labels: ["Company", "Eng", "Sales", "Ops", "Platform", "Apps", "AE", "SE"],
  parents: [
    "",
    "Company",
    "Company",
    "Company",
    "Eng",
    "Eng",
    "Sales",
    "Sales",
  ],
  values: [100, 50, 30, 20, 30, 20, 18, 12],
};

// A single placeholder row. The data-less Plotly-only charts build their traces
// statically (ignoring rows), but ChartWrapper renders its empty state for a
// zero-length dataset — so we hand it one row to render past that check.
const STATIC = [{}];

// ============================================================================
// Layout helpers
// ============================================================================

function SplitBanner() {
  return (
    <div className="grid grid-cols-2 rounded-xl overflow-hidden border shadow-sm mb-6">
      <div className="bg-gradient-to-br from-indigo-600 to-violet-600 text-white px-6 py-5 text-center">
        <div className="text-3xl font-extrabold tracking-tight">PLOTLY</div>
        <div className="text-xs uppercase tracking-widest opacity-90 mt-1">
          ◀ left side · new rendering path
        </div>
      </div>
      <div className="bg-gradient-to-br from-slate-700 to-slate-900 text-white px-6 py-5 text-center">
        <div className="text-3xl font-extrabold tracking-tight">ECHARTS</div>
        <div className="text-xs uppercase tracking-widest opacity-90 mt-1">
          right side · AppKit today ▶
        </div>
      </div>
    </div>
  );
}

/** A single comparison: Plotly (left) vs ECharts (right), same data + props. */
function Compare({
  title,
  description,
  controls,
  plotlyOnly,
  plotly,
  echarts,
}: {
  title: string;
  description: string;
  /** Per-chart controls — only the props that affect this visualization. */
  controls?: ReactNode;
  /** Marks a Plotly-only chart type (shows a small sign, no ECharts twin). */
  plotlyOnly?: boolean;
  plotly: ReactNode;
  echarts: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <CardTitle>{title}</CardTitle>
              {plotlyOnly && (
                <Badge className="gap-1 bg-indigo-600 hover:bg-indigo-600">
                  <SparklesIcon className="h-3 w-3" />
                  Plotly only
                </Badge>
              )}
            </div>
            <CardDescription className="mt-1">{description}</CardDescription>
          </div>
          {controls && (
            <div className="flex items-center gap-x-5 gap-y-2 flex-wrap">
              {controls}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="rounded-lg border border-indigo-200 dark:border-indigo-900/50 p-2">
            {plotly}
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-2">
            {echarts}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Right-column placeholder for chart types ECharts doesn't offer. */
function NotAvailable({ reason }: { reason: string }) {
  return (
    <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-card text-center px-6 py-10">
      <div className="rounded-full border border-dashed p-2.5 text-muted-foreground">
        <SparklesIcon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">
          Not available on ECharts
        </p>
        <p className="text-xs text-muted-foreground mt-1 max-w-[32ch]">
          {reason}
        </p>
      </div>
    </div>
  );
}

/** A compact inline label + control, for use in card headers and the toolbar. */
function InlineControl({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label className="text-xs text-muted-foreground whitespace-nowrap">
        {label}
      </Label>
      {children}
    </div>
  );
}

// ============================================================================
// Route
// ============================================================================

function PlotlyRoute() {
  // Global — applied to every chart.
  const [palette, setPalette] = useState<Palette>("categorical");
  const [showLegend, setShowLegend] = useState(true);
  // Per-card — each control lives in the card it affects.
  const [barOrientation, setBarOrientation] = useState<Orientation>("vertical");
  const [barStacked, setBarStacked] = useState(false);
  const [lineSmooth, setLineSmooth] = useState(true);
  const [lineSymbol, setLineSymbol] = useState(true);
  const [areaStacked, setAreaStacked] = useState(true);
  const [areaSmooth, setAreaSmooth] = useState(true);
  const [donutHole, setDonutHole] = useState(55);
  const [pointSize, setPointSize] = useState(9);

  // Props shared identically by every parity chart on the page.
  const shared = { colorPalette: palette, showLegend, height: 300 } as const;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1400px] mx-auto px-6 py-10">
        <Header
          title="Plotly vs ECharts"
          description="An exhaustive, interactive comparison. Every chart on the left is rendered by the new Plotly components; the matching chart on the right is AppKit's current ECharts component — same data, same props. Flip the controls and watch both update."
          tooltip="Plotly components mirror the ECharts chart API; the controls below drive both columns at once."
        />

        <SplitBanner />

        {/* Global controls — slim toolbar, applies to every chart */}
        <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/40 px-4 py-2.5 mb-8">
          <div className="flex items-center gap-6 flex-wrap">
            <InlineControl label="Color palette">
              <Select
                value={palette}
                onValueChange={(v) => setPalette(v as Palette)}
              >
                <SelectTrigger className="w-[150px] h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="categorical">Categorical</SelectItem>
                  <SelectItem value="sequential">Sequential</SelectItem>
                  <SelectItem value="diverging">Diverging</SelectItem>
                </SelectContent>
              </Select>
            </InlineControl>
            <InlineControl label="Legend">
              <Switch checked={showLegend} onCheckedChange={setShowLegend} />
            </InlineControl>
          </div>
          <span className="hidden sm:block text-xs text-muted-foreground">
            Global · applies to every chart below
          </span>
        </div>

        {/* ============================ Parity ============================ */}
        <h2 className="text-lg font-semibold mb-3">
          Drop-in parity — identical API, two engines
        </h2>
        <div className="flex flex-col gap-6">
          <Compare
            title="Revenue / Cost / Profit"
            description="Multi-series bar in $K."
            controls={
              <>
                <InlineControl label="Orientation">
                  <ToggleGroup
                    type="single"
                    value={barOrientation}
                    onValueChange={(v) =>
                      v && setBarOrientation(v as Orientation)
                    }
                    variant="outline"
                    size="sm"
                  >
                    <ToggleGroupItem value="vertical">Vertical</ToggleGroupItem>
                    <ToggleGroupItem value="horizontal">
                      Horizontal
                    </ToggleGroupItem>
                  </ToggleGroup>
                </InlineControl>
                <InlineControl label="Stacked">
                  <Switch
                    checked={barStacked}
                    onCheckedChange={setBarStacked}
                  />
                </InlineControl>
              </>
            }
            plotly={
              <BarChart
                engine="plotly"
                data={REVENUE}
                xKey="month"
                yKey={["revenue", "cost", "profit"]}
                orientation={barOrientation}
                stacked={barStacked}
                {...shared}
              />
            }
            echarts={
              <BarChart
                data={REVENUE}
                xKey="month"
                yKey={["revenue", "cost", "profit"]}
                orientation={barOrientation}
                stacked={barStacked}
                {...shared}
              />
            }
          />

          <Compare
            title="Daily Active Users"
            description="30-day time series."
            controls={
              <>
                <InlineControl label="Smooth">
                  <Switch
                    checked={lineSmooth}
                    onCheckedChange={setLineSmooth}
                  />
                </InlineControl>
                <InlineControl label="Markers">
                  <Switch
                    checked={lineSymbol}
                    onCheckedChange={setLineSymbol}
                  />
                </InlineControl>
              </>
            }
            plotly={
              <LineChart
                engine="plotly"
                data={DAU}
                xKey="date"
                yKey="users"
                smooth={lineSmooth}
                showSymbol={lineSymbol}
                {...shared}
              />
            }
            echarts={
              <LineChart
                data={DAU}
                xKey="date"
                yKey="users"
                smooth={lineSmooth}
                showSymbol={lineSymbol}
                {...shared}
              />
            }
          />

          <Compare
            title="Revenue vs Cost — Area"
            description="Filled area chart; stack to compare cumulative totals."
            controls={
              <>
                <InlineControl label="Stacked">
                  <Switch
                    checked={areaStacked}
                    onCheckedChange={setAreaStacked}
                  />
                </InlineControl>
                <InlineControl label="Smooth">
                  <Switch
                    checked={areaSmooth}
                    onCheckedChange={setAreaSmooth}
                  />
                </InlineControl>
              </>
            }
            plotly={
              <AreaChart
                engine="plotly"
                data={REVENUE}
                xKey="month"
                yKey={["revenue", "cost"]}
                stacked={areaStacked}
                smooth={areaSmooth}
                {...shared}
              />
            }
            echarts={
              <AreaChart
                data={REVENUE}
                xKey="month"
                yKey={["revenue", "cost"]}
                stacked={areaStacked}
                smooth={areaSmooth}
                {...shared}
              />
            }
          />

          <Compare
            title="Traffic by Source — Pie"
            description="Categorical share of total visits."
            plotly={
              <PieChart
                engine="plotly"
                data={TRAFFIC}
                xKey="source"
                yKey="visits"
                {...shared}
              />
            }
            echarts={
              <PieChart
                data={TRAFFIC}
                xKey="source"
                yKey="visits"
                {...shared}
              />
            }
          />

          <Compare
            title="Traffic by Source — Donut"
            description="Same data as a donut; drag to resize the hole."
            controls={
              <InlineControl label={`Hole ${donutHole}%`}>
                <Slider
                  className="w-[150px]"
                  value={[donutHole]}
                  onValueChange={([v]) => setDonutHole(v)}
                  min={0}
                  max={80}
                  step={5}
                />
              </InlineControl>
            }
            plotly={
              <DonutChart
                engine="plotly"
                data={TRAFFIC}
                xKey="source"
                yKey="visits"
                innerRadius={donutHole}
                {...shared}
              />
            }
            echarts={
              <DonutChart
                data={TRAFFIC}
                xKey="source"
                yKey="visits"
                innerRadius={donutHole}
                {...shared}
              />
            }
          />

          <Compare
            title="Ad Spend vs Conversions — Scatter"
            description="60 points; drag to resize the markers."
            controls={
              <InlineControl label={`Point ${pointSize}px`}>
                <Slider
                  className="w-[150px]"
                  value={[pointSize]}
                  onValueChange={([v]) => setPointSize(v)}
                  min={4}
                  max={20}
                  step={1}
                />
              </InlineControl>
            }
            plotly={
              <ScatterChart
                engine="plotly"
                data={ADS}
                xKey="spend"
                yKey="conversions"
                symbolSize={pointSize}
                {...shared}
              />
            }
            echarts={
              <ScatterChart
                data={ADS}
                xKey="spend"
                yKey="conversions"
                symbolSize={pointSize}
                {...shared}
              />
            }
          />

          <Compare
            title="Team Capabilities — Radar"
            description="Two series across six axes."
            plotly={
              <RadarChart
                engine="plotly"
                data={SKILLS}
                xKey="axis"
                yKey={["teamA", "teamB"]}
                {...shared}
              />
            }
            echarts={
              <RadarChart
                data={SKILLS}
                xKey="axis"
                yKey={["teamA", "teamB"]}
                {...shared}
              />
            }
          />

          <Compare
            title="Weekly Activity — Heatmap"
            description="Day × hour session counts. Sequential palette by design."
            plotly={
              <HeatmapChart
                engine="plotly"
                data={HEATMAP}
                xKey="hour"
                yAxisKey="day"
                yKey="sessions"
                colorPalette="sequential"
                height={300}
              />
            }
            echarts={
              <HeatmapChart
                data={HEATMAP}
                xKey="hour"
                yAxisKey="day"
                yKey="sessions"
                colorPalette="sequential"
                height={300}
              />
            }
          />
        </div>

        <Separator className="my-10" />

        {/* ========================= Plotly-only ========================= */}
        <h2 className="text-lg font-semibold mb-1">
          Beyond ECharts — Plotly-only chart types
        </h2>
        <p className="text-sm text-muted-foreground mb-4">
          Built with the generic{" "}
          <code className="text-xs">{`<PlotlyChart traces={(rows) => [...]} />`}</code>{" "}
          escape hatch — full access to Plotly's trace API. AppKit's ECharts
          charts have no equivalent, so the right column says so.
        </p>

        <div className="flex flex-col gap-6">
          <Compare
            plotlyOnly
            title="3D Scatter"
            description="An interactive helix — drag to rotate, scroll to zoom."
            plotly={
              <PlotlyChart
                data={HELIX_3D}
                height={360}
                traces={(rows) =>
                  [
                    {
                      type: "scatter3d",
                      mode: "markers",
                      x: rows.map((r) => r.x as number),
                      y: rows.map((r) => r.y as number),
                      z: rows.map((r) => r.z as number),
                      marker: {
                        size: 4,
                        color: rows.map((r) => r.z as number),
                        colorscale: "Viridis",
                      },
                    },
                  ] as Data[]
                }
              />
            }
            echarts={
              <NotAvailable reason="WebGL 3D scatter isn't part of AppKit's ECharts chart set." />
            }
          />

          <Compare
            plotlyOnly
            title="3D Surface"
            description="A continuous z = f(x, y) surface with a color gradient."
            plotly={
              <PlotlyChart
                data={STATIC}
                height={360}
                traces={() =>
                  [
                    { type: "surface", z: SURFACE_Z, colorscale: "Viridis" },
                  ] as Data[]
                }
              />
            }
            echarts={
              <NotAvailable reason="Continuous 3D surfaces need a GL rendering engine." />
            }
          />

          <Compare
            plotlyOnly
            title="Sankey Diagram"
            description="Flow from traffic sources → outcomes."
            plotly={
              <PlotlyChart
                data={STATIC}
                height={360}
                traces={() =>
                  [
                    {
                      type: "sankey",
                      orientation: "h",
                      node: {
                        pad: 18,
                        thickness: 18,
                        line: { width: 0 },
                        label: [
                          "Organic",
                          "Paid",
                          "Social",
                          "Signup",
                          "Purchase",
                          "Churn",
                        ],
                        color: [
                          "#6366f1",
                          "#8b5cf6",
                          "#a855f7",
                          "#22c55e",
                          "#0ea5e9",
                          "#ef4444",
                        ],
                      },
                      link: {
                        source: [0, 0, 1, 1, 2, 3, 3],
                        target: [3, 5, 3, 4, 3, 4, 5],
                        value: [800, 200, 500, 300, 400, 900, 300],
                        // Default link color is ~20% gray and barely visible;
                        // tint each flow by its source node.
                        color: [
                          "rgba(99,102,241,0.4)",
                          "rgba(99,102,241,0.4)",
                          "rgba(139,92,246,0.4)",
                          "rgba(139,92,246,0.4)",
                          "rgba(168,85,247,0.4)",
                          "rgba(34,197,94,0.4)",
                          "rgba(34,197,94,0.4)",
                        ],
                      },
                    },
                  ] as Data[]
                }
              />
            }
            echarts={
              <NotAvailable reason="No Sankey component in AppKit's ECharts chart set." />
            }
          />

          <Compare
            plotlyOnly
            title="Sunburst"
            description="Hierarchical breakdown of spend by org → team."
            plotly={
              <PlotlyChart
                data={STATIC}
                height={360}
                traces={() => [{ ...HIERARCHY, type: "sunburst" }] as Data[]}
              />
            }
            echarts={
              <NotAvailable reason="No hierarchical sunburst component available." />
            }
          />

          <Compare
            plotlyOnly
            title="Candlestick"
            description="OHLC financial series with auto up/down coloring."
            plotly={
              <PlotlyChart
                data={CANDLES}
                height={360}
                traces={(rows) =>
                  [
                    {
                      type: "candlestick",
                      x: rows.map((r) => r.date as string),
                      open: rows.map((r) => r.open as number),
                      high: rows.map((r) => r.high as number),
                      low: rows.map((r) => r.low as number),
                      close: rows.map((r) => r.close as number),
                    },
                  ] as Data[]
                }
              />
            }
            echarts={
              <NotAvailable reason="No OHLC / candlestick component for financial data." />
            }
          />

          <Compare
            plotlyOnly
            title="Contour"
            description="A 2D contour map of the same surface field."
            plotly={
              <PlotlyChart
                data={STATIC}
                height={360}
                traces={() =>
                  [
                    { type: "contour", z: SURFACE_Z, colorscale: "Electric" },
                  ] as Data[]
                }
              />
            }
            echarts={
              <NotAvailable reason="No contour / density component available." />
            }
          />

          <Compare
            plotlyOnly
            title="Bubble Chart"
            description="Market segments: x = growth %, y = margin %, size = revenue."
            plotly={
              <PlotlyChart
                data={BUBBLES}
                height={360}
                traces={(rows) =>
                  [
                    {
                      type: "scatter",
                      mode: "markers+text",
                      x: rows.map((r) => r.growth as number),
                      y: rows.map((r) => r.margin as number),
                      text: rows.map((r) => r.name as string),
                      textposition: "top center",
                      marker: {
                        size: rows.map((r) => r.revenue as number),
                        sizemode: "area",
                        sizeref: 0.3,
                        color: rows.map((r) => r.growth as number),
                        colorscale: "Bluered",
                        showscale: true,
                      },
                    },
                  ] as unknown as Data[]
                }
              />
            }
            echarts={
              <NotAvailable reason="Size-encoded bubble scatter isn't exposed by the ECharts charts." />
            }
          />

          <Compare
            plotlyOnly
            title="Funnel"
            description="Conversion funnel from visits to paid."
            plotly={
              <PlotlyChart
                data={STATIC}
                height={360}
                traces={() =>
                  [
                    {
                      type: "funnel",
                      y: ["Visits", "Signups", "Trials", "Paid"],
                      x: [12000, 5200, 2400, 900],
                    },
                  ] as Data[]
                }
              />
            }
            echarts={
              <NotAvailable reason="No funnel component in AppKit's ECharts chart set." />
            }
          />

          <Compare
            plotlyOnly
            title="Polar Bar (Wind Rose)"
            description="A barpolar chart — categories arranged radially."
            plotly={
              <PlotlyChart
                data={STATIC}
                height={360}
                traces={() =>
                  [
                    {
                      type: "barpolar",
                      r: [40, 62, 55, 71, 48, 66, 38, 59],
                      theta: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"],
                    },
                  ] as Data[]
                }
              />
            }
            echarts={
              <NotAvailable reason="No polar / radial bar component available." />
            }
          />

          <Compare
            plotlyOnly
            title="Treemap"
            description="Same hierarchy as the sunburst, as nested rectangles."
            plotly={
              <PlotlyChart
                data={STATIC}
                height={360}
                traces={() => [{ ...HIERARCHY, type: "treemap" }] as Data[]}
              />
            }
            echarts={
              <NotAvailable reason="No treemap component in AppKit's ECharts chart set." />
            }
          />
        </div>
      </div>
    </div>
  );
}
