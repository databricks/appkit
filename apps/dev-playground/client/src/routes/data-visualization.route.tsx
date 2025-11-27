import {
  AreaChart,
  BarChart,
  DataTable,
  LineChart,
  PieChart,
  RadarChart,
} from "@databricks/app-kit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const Route = createFileRoute("/data-visualization")({
  component: DataVisualizationRoute,
});

function CodeSnippet({ code }: { code: string }) {
  const [isVisible, setIsVisible] = useState(false);
  const [html, setHtml] = useState("");

  useEffect(() => {
    if (isVisible) {
      codeToHtml(code, {
        lang: "tsx",
        theme: "dark-plus",
      }).then(setHtml);
    }
  }, [isVisible, code]);

  return (
    <div className="mt-4">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsVisible(!isVisible)}
        className="w-full"
      >
        {isVisible ? "Hide Code" : "Show Code"}
      </Button>
      {isVisible && html && (
        <div
          className="mt-2 rounded-md overflow-hidden [&>pre]:m-0 [&>pre]:p-4 [&>pre]:text-sm"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}

function DataVisualizationRoute() {
  // Default params for the demo - last 30 days
  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const commonParams = {
    startDate,
    endDate,
    aggregationLevel: "day",
  };

  const spendDataParams = {
    ...commonParams,
    appId: "all",
    creator: "all",
    groupBy: "default",
  };

  return (
    <div className="min-h-[calc(100vh-73px)] bg-gray-50">
      <div className="max-w-[1200px] mx-auto px-6 py-12">
        <Header
          title="Data Visualization"
          description="Explore powerful and customizable chart components from the Apps SDK."
          tooltip="Showcase of BarChart, AreaChart, LineChart, PieChart, and RadarChart components"
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Area Chart - Natural Curve */}
          <Card>
            <CardHeader>
              <CardTitle>Usage Trends</CardTitle>
              <CardDescription>Area Chart with natural curve</CardDescription>
            </CardHeader>
            <CardContent>
              <AreaChart
                queryKey="spend_data"
                parameters={spendDataParams}
                curveType="natural"
              />
              <CodeSnippet
                code={`<AreaChart
  queryKey="spend_data"
  parameters={spendDataParams}
  curveType="natural"
/>`}
              />
            </CardContent>
          </Card>

          {/* Area Chart - Linear Curve */}
          <Card>
            <CardHeader>
              <CardTitle>Usage Trends (Linear)</CardTitle>
              <CardDescription>Area Chart with linear curve</CardDescription>
            </CardHeader>
            <CardContent>
              <AreaChart
                queryKey="spend_data"
                parameters={spendDataParams}
                curveType="linear"
              />
              <CodeSnippet
                code={`<AreaChart
  queryKey="spend_data"
  parameters={spendDataParams}
  curveType="linear"
/>`}
              />
            </CardContent>
          </Card>

          {/* Bar Chart - Vertical */}
          <Card>
            <CardHeader>
              <CardTitle>Top Contributors</CardTitle>
              <CardDescription>Vertical Bar Chart</CardDescription>
            </CardHeader>
            <CardContent>
              <BarChart
                queryKey="top_contributors"
                parameters={commonParams}
                orientation="vertical"
              />
              <CodeSnippet
                code={`<BarChart
  queryKey="top_contributors"
  parameters={commonParams}
  orientation="vertical"
/>`}
              />
            </CardContent>
          </Card>

          {/* Bar Chart - Horizontal */}
          <Card>
            <CardHeader>
              <CardTitle>Top Contributors</CardTitle>
              <CardDescription>Horizontal Bar Chart</CardDescription>
            </CardHeader>
            <CardContent>
              <BarChart
                queryKey="top_contributors"
                parameters={commonParams}
                orientation="horizontal"
              />
              <CodeSnippet
                code={`<BarChart
  queryKey="top_contributors"
  parameters={commonParams}
  orientation="horizontal"
/>`}
              />
            </CardContent>
          </Card>

          {/* Line Chart - Without Dots */}
          <Card>
            <CardHeader>
              <CardTitle>Daily Spend Trend</CardTitle>
              <CardDescription>Line Chart with smooth curve</CardDescription>
            </CardHeader>
            <CardContent>
              <LineChart
                queryKey="spend_data"
                parameters={spendDataParams}
                curveType="monotone"
                showDots={false}
              />
              <CodeSnippet
                code={`<LineChart
  queryKey="spend_data"
  parameters={spendDataParams}
  curveType="monotone"
  showDots={false}
/>`}
              />
            </CardContent>
          </Card>

          {/* Line Chart - With Dots */}
          <Card>
            <CardHeader>
              <CardTitle>Daily Spend Trend (With Dots)</CardTitle>
              <CardDescription>Line Chart showing data points</CardDescription>
            </CardHeader>
            <CardContent>
              <LineChart
                queryKey="spend_data"
                parameters={spendDataParams}
                curveType="monotone"
                showDots={true}
              />
              <CodeSnippet
                code={`<LineChart
  queryKey="spend_data"
  parameters={spendDataParams}
  curveType="monotone"
  showDots={true}
/>`}
              />
            </CardContent>
          </Card>

          {/* Pie Chart */}
          <Card>
            <CardHeader>
              <CardTitle>Cost Distribution</CardTitle>
              <CardDescription>Pie Chart showing proportions</CardDescription>
            </CardHeader>
            <CardContent>
              <PieChart queryKey="top_contributors" parameters={commonParams} />
              <CodeSnippet
                code={`<PieChart
  queryKey="top_contributors"
  parameters={commonParams}
/>`}
              />
            </CardContent>
          </Card>

          {/* Donut Chart with Center Label */}
          <Card>
            <CardHeader>
              <CardTitle>Cost Distribution (Donut)</CardTitle>
              <CardDescription>
                Donut Chart with total in center
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PieChart
                queryKey="top_contributors"
                parameters={commonParams}
                innerRadius={60}
                showLabel={true}
              />
              <CodeSnippet
                code={`<PieChart
  queryKey="top_contributors"
  parameters={commonParams}
  innerRadius={60}
  showLabel={true}
/>`}
              />
            </CardContent>
          </Card>

          {/* Radar Chart - Without Dots */}
          <Card>
            <CardHeader>
              <CardTitle>Performance Metrics</CardTitle>
              <CardDescription>Radar Chart showing dimensions</CardDescription>
            </CardHeader>
            <CardContent>
              <RadarChart
                queryKey="spend_data"
                parameters={spendDataParams}
                fillOpacity={0.6}
              />
              <CodeSnippet
                code={`<RadarChart
  queryKey="spend_data"
  parameters={spendDataParams}
  fillOpacity={0.6}
/>`}
              />
            </CardContent>
          </Card>

          {/* Radar Chart - With Dots */}
          <Card>
            <CardHeader>
              <CardTitle>Performance Metrics (With Dots)</CardTitle>
              <CardDescription>Radar Chart with data points</CardDescription>
            </CardHeader>
            <CardContent>
              <RadarChart
                queryKey="spend_data"
                parameters={spendDataParams}
                showDots={true}
                fillOpacity={0.4}
              />
              <CodeSnippet
                code={`<RadarChart
  queryKey="spend_data"
  parameters={spendDataParams}
  showDots={true}
  fillOpacity={0.4}
/>`}
              />
            </CardContent>
          </Card>

          {/* DataTable - Simple */}
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Simple Data Table</CardTitle>
              <CardDescription>
                Basic table with automatic column generation
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataTable queryKey="untagged_apps" parameters={commonParams} />
              <CodeSnippet
                code={`<DataTable
  queryKey="untagged_apps"
  parameters={commonParams}
/>`}
              />
            </CardContent>
          </Card>

          {/* DataTable - All Features */}
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Advanced Data Table</CardTitle>
              <CardDescription>
                Table with row selection, column resizing, custom filter, and
                custom labels
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataTable
                queryKey="untagged_apps"
                parameters={commonParams}
                enableRowSelection={true}
                onRowSelectionChange={(selection) => {
                  console.log("Selected rows:", selection);
                }}
                filterColumn="name"
                filterPlaceholder="Search apps..."
                labels={{
                  columnsButton: "Manage Columns",
                  noResults: "No apps found",
                  rowsFound: `\${count} app(s) displayed`,
                  previousButton: "Prev",
                  nextButton: "Next",
                }}
              />
              <CodeSnippet
                code={`<DataTable
  queryKey="untagged_apps"
  parameters={commonParams}
  enableRowSelection={true}
  onRowSelectionChange={(selection) => {
    console.log("Selected rows:", selection);
  }}
  filterColumn="name"
  filterPlaceholder="Search apps..."
  labels={{
    columnsButton: "Manage Columns",
    noResults: "No apps found",
    rowsFound: "\${count} app(s) displayed",
    previousButton: "Prev",
    nextButton: "Next",
  }}
/>`}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
