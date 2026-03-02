import {
  Card,
  GenieQueryVisualization,
  inferChartType,
  transformGenieData,
} from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

export const Route = createFileRoute("/chart-inference")({
  component: ChartInferenceRoute,
});

// ---------------------------------------------------------------------------
// Helper to build a Genie-shaped statement_response from simple definitions
// ---------------------------------------------------------------------------

interface SampleColumn {
  name: string;
  type_name: string;
}

function makeStatementResponse(
  columns: SampleColumn[],
  rows: (string | null)[][],
) {
  return {
    manifest: { schema: { columns } },
    result: { data_array: rows },
  };
}

// ---------------------------------------------------------------------------
// Sample datasets — one per inference rule
// ---------------------------------------------------------------------------

const SAMPLES: {
  title: string;
  description: string;
  expected: string;
  data: ReturnType<typeof makeStatementResponse>;
}[] = [
  {
    title: "Timeseries (date + revenue)",
    description: "Rule 1: DATE + numeric → line chart",
    expected: "line",
    data: makeStatementResponse(
      [
        { name: "date", type_name: "DATE" },
        { name: "revenue", type_name: "DECIMAL" },
      ],
      [
        ["2024-01-01", "12000"],
        ["2024-02-01", "15500"],
        ["2024-03-01", "13200"],
        ["2024-04-01", "17800"],
        ["2024-05-01", "19200"],
        ["2024-06-01", "21000"],
        ["2024-07-01", "18500"],
        ["2024-08-01", "22100"],
        ["2024-09-01", "24500"],
        ["2024-10-01", "23000"],
        ["2024-11-01", "26800"],
        ["2024-12-01", "29000"],
      ],
    ),
  },
  {
    title: "Few categories (region + sales)",
    description: "Rule 2: STRING + 1 numeric, 3 categories → pie chart",
    expected: "pie",
    data: makeStatementResponse(
      [
        { name: "region", type_name: "STRING" },
        { name: "sales", type_name: "DECIMAL" },
      ],
      [
        ["North America", "45000"],
        ["Europe", "32000"],
        ["Asia Pacific", "28000"],
      ],
    ),
  },
  {
    title: "Moderate categories (product + revenue)",
    description: "Rule 3: STRING + 1 numeric, 15 categories → bar chart",
    expected: "bar",
    data: makeStatementResponse(
      [
        { name: "product", type_name: "STRING" },
        { name: "revenue", type_name: "DECIMAL" },
      ],
      Array.from({ length: 15 }, (_, i) => [
        `Product ${String.fromCharCode(65 + i)}`,
        String(Math.round(5000 + Math.sin(i) * 3000)),
      ]),
    ),
  },
  {
    title: "Many categories (city + population)",
    description: "Rule 4: STRING + 1 numeric, 150 categories → line chart",
    expected: "line",
    data: makeStatementResponse(
      [
        { name: "city", type_name: "STRING" },
        { name: "population", type_name: "INT" },
      ],
      Array.from({ length: 150 }, (_, i) => [
        `City ${i + 1}`,
        String(Math.round(10000 + Math.random() * 90000)),
      ]),
    ),
  },
  {
    title: "Multi-series timeseries (month + revenue + cost)",
    description: "Rule 1: DATE + multiple numerics → line chart",
    expected: "line",
    data: makeStatementResponse(
      [
        { name: "month", type_name: "DATE" },
        { name: "revenue", type_name: "DECIMAL" },
        { name: "cost", type_name: "DECIMAL" },
      ],
      [
        ["2024-01-01", "12000", "8000"],
        ["2024-02-01", "15500", "9200"],
        ["2024-03-01", "13200", "8800"],
        ["2024-04-01", "17800", "10500"],
        ["2024-05-01", "19200", "11000"],
        ["2024-06-01", "21000", "12500"],
      ],
    ),
  },
  {
    title: "Grouped bar (department + budget + actual)",
    description: "Rule 5: STRING + N numerics, 8 categories → bar chart",
    expected: "bar",
    data: makeStatementResponse(
      [
        { name: "department", type_name: "STRING" },
        { name: "budget", type_name: "DECIMAL" },
        { name: "actual", type_name: "DECIMAL" },
      ],
      [
        ["Engineering", "500000", "480000"],
        ["Marketing", "300000", "320000"],
        ["Sales", "400000", "410000"],
        ["Support", "200000", "190000"],
        ["HR", "150000", "145000"],
        ["Finance", "180000", "175000"],
        ["Legal", "120000", "115000"],
        ["Operations", "250000", "240000"],
      ],
    ),
  },
  {
    title: "Scatter (height + weight)",
    description: "Rule 7: 2 numerics only → scatter chart",
    expected: "scatter",
    data: makeStatementResponse(
      [
        { name: "height_cm", type_name: "DOUBLE" },
        { name: "weight_kg", type_name: "DOUBLE" },
      ],
      Array.from({ length: 30 }, (_, i) => [
        String(150 + i * 1.2),
        String(Math.round(45 + i * 1.5 + (Math.random() - 0.5) * 10)),
      ]),
    ),
  },
  {
    title: "Single row (name + value)",
    description: "Skip: < 2 rows → table only",
    expected: "none (table only)",
    data: makeStatementResponse(
      [
        { name: "metric", type_name: "STRING" },
        { name: "value", type_name: "DECIMAL" },
      ],
      [["Total Revenue", "125000"]],
    ),
  },
  {
    title: "All strings (first_name + last_name + city)",
    description: "Skip: no numeric columns → table only",
    expected: "none (table only)",
    data: makeStatementResponse(
      [
        { name: "first_name", type_name: "STRING" },
        { name: "last_name", type_name: "STRING" },
        { name: "city", type_name: "STRING" },
      ],
      [
        ["Alice", "Smith", "New York"],
        ["Bob", "Jones", "London"],
        ["Carol", "Lee", "Tokyo"],
      ],
    ),
  },
];

// ---------------------------------------------------------------------------
// Per-sample card component
// ---------------------------------------------------------------------------

function SampleCard({
  title,
  description,
  expected,
  data,
}: (typeof SAMPLES)[number]) {
  const transformed = useMemo(() => transformGenieData(data), [data]);
  const inference = useMemo(
    () =>
      transformed
        ? inferChartType(transformed.rows, transformed.columns)
        : null,
    [transformed],
  );

  return (
    <Card className="p-6 flex flex-col gap-4">
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      <div className="flex gap-4 text-xs">
        <span>
          <strong>Expected:</strong> {expected}
        </span>
        <span>
          <strong>Inferred:</strong>{" "}
          {inference
            ? `${inference.chartType} (x: ${inference.xKey}, y: ${Array.isArray(inference.yKey) ? inference.yKey.join(", ") : inference.yKey})`
            : "null (no chart)"}
        </span>
        <span>
          <strong>Rows:</strong> {transformed?.rows.length ?? 0}
        </span>
        <span>
          <strong>Columns:</strong> {transformed?.columns.length ?? 0}
        </span>
      </div>

      <GenieQueryVisualization data={data} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Route component
// ---------------------------------------------------------------------------

function ChartInferenceRoute() {
  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-5xl mx-auto px-6 py-12">
        <div className="flex flex-col gap-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">
              Chart Inference Demo
            </h1>
            <p className="text-muted-foreground mt-2">
              Sample datasets exercising each Genie chart inference rule. Each
              card shows the inferred chart type, axes, and the rendered
              visualization.
            </p>
          </div>

          <div className="flex flex-col gap-6">
            {SAMPLES.map((sample) => (
              <SampleCard key={sample.title} {...sample} />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
