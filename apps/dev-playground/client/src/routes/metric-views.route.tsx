import { formatLabel, formatValue } from "@databricks/appkit-ui/js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  LineChart,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useMetricView,
} from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import { Header } from "@/components/layout/header";

export const Route = createFileRoute("/metric-views")({
  component: MetricViewsRoute,
});

// Columns we ask the metric view for. Declared at module scope so their
// array identities stay stable across renders — `useMetricView` serializes
// the request body, so this also keeps the SSE subscription from re-firing.
const MEASURES = ["arr", "mrr"] as const;
const DIMENSIONS = ["created_at"] as const;

function MetricViewsRoute() {
  // Measure the `revenue` metric view: annual + monthly recurring revenue,
  // bucketed by month over the `created_at` time dimension. Measure /
  // dimension names, the time grain, and the row shape are all inferred from
  // the generated `MetricRegistry` augmentation (shared/appkit-types/metric-views.ts).
  const { data, loading, error, metadata } = useMetricView("revenue", {
    measures: MEASURES,
    dimensions: DIMENSIONS,
    timeGrain: "month",
    timeDimension: "created_at",
  });

  // The columns we rendered, in display order. `metadata` is the
  // payload-carried, client-agnostic per-column display metadata the server
  // stamped onto the SSE result from `analytics({ metricViewsMetadata })`.
  const columns = ["created_at", ...MEASURES] as const;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1100px] mx-auto px-6 py-12">
        <Header
          title="Metric Views"
          description="Measure a governed Unity Catalog metric view with useMetricView — no SQL, and every label + number format sourced from server-injected metadata."
          tooltip="POST /api/analytics/metric/revenue streams typed rows plus per-column metadata (display_name / format). The client never hard-codes a format string."
        />

        <Card>
          <CardHeader>
            <CardTitle>Recurring revenue by month</CardTitle>
            <CardDescription>
              revenue · measures {MEASURES.join(", ")} · grouped by month
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-8">
            {loading && <Skeleton className="h-64 w-full" />}

            {error && (
              <div className="text-destructive text-sm" role="alert">
                {error}
              </div>
            )}

            {!loading && !error && (!data || data.length === 0) && (
              <div className="text-muted-foreground text-sm">
                No results for this metric view.
              </div>
            )}

            {!loading && !error && data && data.length > 0 && (
              <>
                <LineChart
                  data={data}
                  xKey="created_at"
                  yKey={[...MEASURES]}
                  height={320}
                  showLegend
                  title="ARR vs MRR over time"
                />

                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {columns.map((col) => (
                          <TableHead key={col}>
                            {/* Human label from metadata.display_name,
                                else a humanized fallback. */}
                            {formatLabel(col, metadata?.[col])}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.map((row, i) => (
                        <TableRow key={`${String(row.created_at)}-${i}`}>
                          {columns.map((col) => (
                            <TableCell key={col}>
                              {/* Format string comes from metadata, never
                                  hand-typed. When `metadata` is undefined
                                  (server injected none / unknown key),
                                  `metadata?.[col]?.format` is undefined and
                                  formatValue degrades to a sensible default. */}
                              {formatValue(row[col], metadata?.[col]?.format)}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
