import { AnalyticsHeader } from "@/components/analytics";
import { sql } from "@databricks/appkit-ui/js";
import {
  AreaChart,
  BarChart,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DonutChart,
  HeatmapChart,
  LineChart,
  PieChart,
} from "@databricks/appkit-ui/react";
import { createFileRoute, retainSearchParams } from "@tanstack/react-router";

export const Route = createFileRoute("/arrow-analytics")({
  component: ArrowAnalyticsRoute,
  search: {
    middlewares: [retainSearchParams(true)],
  },
});

function ArrowAnalyticsRoute() {
  const endDate = new Date();
  const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const commonParams = {
    startDate: sql.date(startDate),
    endDate: sql.date(endDate),
    aggregationLevel: sql.string("day"),
  };

  const spendDataParams = {
    ...commonParams,
    appId: sql.string("all"),
    creator: sql.string("all"),
    groupBy: sql.string("default"),
  };

  const topContributorsParams = {
    ...commonParams,
  };

  const heatmapParams = {
    startDate: sql.date(startDate),
    endDate: sql.date(endDate),
  };

  return (
    <div className="min-h-screen bg-background">
      <AnalyticsHeader />

      <main className="max-w-7xl mx-auto px-6 py-12">
        <div className="flex flex-col gap-6">
          {/* ============================================================ */}
          {/* UNIFIED CHARTS - FORMAT COMPARISON */}
          {/* ============================================================ */}
          <div>
            <h2 className="text-2xl font-bold mb-4">Unified Charts API</h2>
            <p className="text-muted-foreground mb-6">
              The same chart component can fetch data in either{" "}
              <code className="bg-muted px-1 rounded">format="json"</code> or{" "}
              <code className="bg-muted px-1 rounded">format="arrow"</code>.
              Below are side-by-side comparisons of the same query rendered with
              both formats.
            </p>

            {/* ============================================================ */}
            {/* apps_list Query - Bar Charts */}
            {/* ============================================================ */}
            <h3 className="text-lg font-semibold mb-4 mt-8 border-b pb-2">
              📊 Bar Chart - <code className="text-sm">apps_list</code> query
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>JSON Format</CardTitle>
                  <CardDescription>
                    <code>format="json"</code> - Traditional JSON response
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <BarChart
                    queryKey="apps_list"
                    parameters={{}}
                    format="json"
                    orientation="horizontal"
                    xKey="name"
                    yKey="totalSpend"
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Arrow Format</CardTitle>
                  <CardDescription>
                    <code>format="arrow"</code> - Binary Arrow IPC (faster for
                    large data)
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <BarChart
                    queryKey="apps_list"
                    parameters={{}}
                    format="arrow"
                    orientation="horizontal"
                    xKey="name"
                    yKey="totalSpend"
                  />
                </CardContent>
              </Card>
            </div>

            {/* ============================================================ */}
            {/* spend_data Query - Line Charts */}
            {/* ============================================================ */}
            <h3 className="text-lg font-semibold mb-4 mt-8 border-b pb-2">
              📈 Line Chart - <code className="text-sm">spend_data</code> query
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>JSON Format</CardTitle>
                  <CardDescription>
                    <code>format="json"</code> - Time series spend data
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <LineChart
                    queryKey="spend_data"
                    parameters={spendDataParams}
                    format="json"
                    xKey="aggregation_period"
                    yKey="cost_usd"
                    smooth={true}
                    showSymbol={false}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Arrow Format</CardTitle>
                  <CardDescription>
                    <code>format="arrow"</code> - Time series spend data
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <LineChart
                    queryKey="spend_data"
                    parameters={spendDataParams}
                    format="arrow"
                    xKey="aggregation_period"
                    yKey="cost_usd"
                    smooth={true}
                    showSymbol={false}
                  />
                </CardContent>
              </Card>
            </div>

            {/* ============================================================ */}
            {/* spend_data Query - Area Charts */}
            {/* ============================================================ */}
            <h3 className="text-lg font-semibold mb-4 mt-8 border-b pb-2">
              📊 Area Chart - <code className="text-sm">spend_data</code> query
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>JSON Format</CardTitle>
                  <CardDescription>
                    <code>format="json"</code> - Area visualization
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <AreaChart
                    queryKey="spend_data"
                    parameters={spendDataParams}
                    format="json"
                    xKey="aggregation_period"
                    yKey="cost_usd"
                    smooth={true}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Arrow Format</CardTitle>
                  <CardDescription>
                    <code>format="arrow"</code> - Area visualization
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <AreaChart
                    queryKey="spend_data"
                    parameters={spendDataParams}
                    format="arrow"
                    xKey="aggregation_period"
                    yKey="cost_usd"
                    smooth={true}
                  />
                </CardContent>
              </Card>
            </div>

            {/* ============================================================ */}
            {/* apps_list Query - Pie Charts */}
            {/* ============================================================ */}
            <h3 className="text-lg font-semibold mb-4 mt-8 border-b pb-2">
              🥧 Pie Chart - <code className="text-sm">apps_list</code> query
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>JSON Format</CardTitle>
                  <CardDescription>
                    <code>format="json"</code> - Apps distribution
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <PieChart
                    queryKey="apps_list"
                    parameters={{}}
                    format="json"
                    xKey="name"
                    yKey="totalSpend"
                    showLabels={true}
                    labelPosition="outside"
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Arrow Format</CardTitle>
                  <CardDescription>
                    <code>format="arrow"</code> - Apps distribution
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <PieChart
                    queryKey="apps_list"
                    parameters={{}}
                    format="arrow"
                    xKey="name"
                    yKey="totalSpend"
                    showLabels={true}
                    labelPosition="outside"
                  />
                </CardContent>
              </Card>
            </div>

            {/* ============================================================ */}
            {/* top_contributors Query - Donut Charts */}
            {/* ============================================================ */}
            <h3 className="text-lg font-semibold mb-4 mt-8 border-b pb-2">
              🍩 Donut Chart - <code className="text-sm">top_contributors</code>{" "}
              query
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>JSON Format</CardTitle>
                  <CardDescription>
                    <code>format="json"</code> - Top 10 contributors
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <DonutChart
                    queryKey="top_contributors"
                    parameters={topContributorsParams}
                    format="json"
                    xKey="app_name"
                    yKey="total_cost_usd"
                    innerRadius={50}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Arrow Format</CardTitle>
                  <CardDescription>
                    <code>format="arrow"</code> - Top 10 contributors
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <DonutChart
                    queryKey="top_contributors"
                    parameters={topContributorsParams}
                    format="arrow"
                    xKey="app_name"
                    yKey="total_cost_usd"
                    innerRadius={50}
                  />
                </CardContent>
              </Card>
            </div>

            {/* ============================================================ */}
            {/* Auto Format Selection */}
            {/* ============================================================ */}
            <h3 className="text-lg font-semibold mb-4 mt-8 border-b pb-2">
              🔄 Auto Format - <code className="text-sm">format="auto"</code>
            </h3>
            <p className="text-muted-foreground mb-4">
              When using{" "}
              <code className="bg-muted px-1 rounded">format="auto"</code> (the
              default), the chart automatically selects Arrow for larger
              datasets based on query hints.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Auto Format (apps_list)</CardTitle>
                  <CardDescription>
                    <code>format="auto"</code> - Selects best format
                    automatically
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <BarChart
                    queryKey="apps_list"
                    parameters={{}}
                    title="Apps by Spend (Auto)"
                    orientation="horizontal"
                    xKey="name"
                    yKey="totalSpend"
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Auto Format (spend_data)</CardTitle>
                  <CardDescription>
                    <code>format="auto"</code> - Time series with auto format
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <LineChart
                    queryKey="spend_data"
                    parameters={spendDataParams}
                    title="Spend Over Time (Auto)"
                    xKey="aggregation_period"
                    yKey="cost_usd"
                    smooth={true}
                  />
                </CardContent>
              </Card>
            </div>

            {/* ============================================================ */}
            {/* Heatmap Chart */}
            {/* ============================================================ */}
            <h3 className="text-lg font-semibold mb-4 mt-8 border-b pb-2">
              🔥 Heatmap Chart -{" "}
              <code className="text-sm">app_activity_heatmap</code> query
            </h3>
            <p className="text-muted-foreground mb-4">
              Heatmaps visualize data intensity across two categorical
              dimensions. Shows app spend by app name and day of week.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>JSON Format</CardTitle>
                  <CardDescription>
                    <code>format="json"</code> - App activity by day of week
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <HeatmapChart
                    queryKey="app_activity_heatmap"
                    parameters={heatmapParams}
                    format="json"
                    xKey="day_of_week"
                    yAxisKey="app_name"
                    yKey="spend"
                    title="App Activity (JSON)"
                    showLabels={false}
                    height={400}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Arrow Format</CardTitle>
                  <CardDescription>
                    <code>format="arrow"</code> - Same query with Arrow
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <HeatmapChart
                    queryKey="app_activity_heatmap"
                    parameters={heatmapParams}
                    format="arrow"
                    xKey="day_of_week"
                    yAxisKey="app_name"
                    yKey="spend"
                    title="App Activity (Arrow)"
                    showLabels={false}
                    height={400}
                  />
                </CardContent>
              </Card>
            </div>

            {/* ============================================================ */}
            {/* Data Mode - Inline JSON */}
            {/* ============================================================ */}
            <h3 className="text-lg font-semibold mb-4 mt-8 border-b pb-2">
              📝 Data Mode - Inline JSON (no query)
            </h3>
            <p className="text-muted-foreground mb-4">
              You can also pass data directly to charts using the{" "}
              <code className="bg-muted px-1 rounded">data</code> prop instead
              of <code className="bg-muted px-1 rounded">queryKey</code>.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Direct JSON Data</CardTitle>
                  <CardDescription>
                    <code>data={`{[...]}`}</code> - No server request needed
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <BarChart
                    data={[
                      { department: "Engineering", budget: 4200000 },
                      { department: "Marketing", budget: 2100000 },
                      { department: "Sales", budget: 1800000 },
                      { department: "Support", budget: 900000 },
                      { department: "HR", budget: 600000 },
                    ]}
                    xKey="department"
                    yKey="budget"
                    title="Department Budgets"
                    orientation="horizontal"
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Multi-Series JSON Data</CardTitle>
                  <CardDescription>
                    <code>yKey={`{["a", "b"]}`}</code> - Multiple series from
                    JSON
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <LineChart
                    data={[
                      { month: "Jan", revenue: 12000, cost: 8000 },
                      { month: "Feb", revenue: 15000, cost: 9500 },
                      { month: "Mar", revenue: 18000, cost: 10000 },
                      { month: "Apr", revenue: 16000, cost: 9000 },
                      { month: "May", revenue: 21000, cost: 11000 },
                      { month: "Jun", revenue: 24000, cost: 12500 },
                    ]}
                    xKey="month"
                    yKey={["revenue", "cost"]}
                    title="Revenue vs Cost"
                    showSymbol={true}
                    smooth={true}
                  />
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
