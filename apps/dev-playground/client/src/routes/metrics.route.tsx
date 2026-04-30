import {
  formatLabel,
  formatValue,
  toD3Format,
} from "@databricks/appkit-ui/format";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  useMetricView,
} from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import Plot from "react-plotly.js";
import { Header } from "@/components/layout/header";

export const Route = createFileRoute("/metrics")({
  component: MetricsRoute,
});

/**
 * Phase 7 demo route — exercises the full UC Metric View stack:
 *
 *  1. `useMetricView("revenue", { measures, dimensions, timeGrain, filter })`
 *     against the SP-lane revenue metric. Plotly chart wires `metadata.measures.arr.format`
 *     into `layout.yaxis.tickformat` via `toD3Format()` and `metadata.measures.arr.display_name`
 *     into the trace name + axis title via `formatLabel()`.
 *
 *  2. `useMetricView("customer_metrics", ...)` against the OBO-lane customer metric.
 *     The dev-playground exposes `/whoami` so the route can show "executing as <user>".
 *     Cache keys for OBO entries incorporate the hashed user identity (Phase 4),
 *     so the SP and OBO panels live independently.
 *
 *  3. A hardcoded structured filter (`region in [EMEA, APAC]`) demonstrates the
 *     12-op filter spec — the server validates the predicate and parameterizes
 *     the values before they reach the SQL Warehouse.
 *
 * Graceful degradation: the demo workspace does not host the underlying UC
 * metric views, so both queries surface a server error in real dev sessions.
 * The route renders the metadata flow + the typed surface either way; the
 * "Could not load metric" panel is the v1 demo's expected behavior.
 */

interface WhoamiResponse {
  xForwardedUser: string | null;
  adminUserId: string | null;
  isAdmin: boolean;
}

function useWhoami() {
  const [user, setUser] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/whoami")
      .then((res) => res.json() as Promise<WhoamiResponse>)
      .then((data) => {
        if (cancelled) return;
        setUser(data.xForwardedUser);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { user, loading };
}

/**
 * Plotly trace data shape for the revenue line chart. Built from the result of
 * `useMetricView("revenue", ...)`. Each row carries the chosen measure (`arr`)
 * and the chosen dimensions (`region`, `created_at`).
 */
type RevenueRow = {
  arr: number;
  region: string;
  created_at: string;
};

function RevenueChart() {
  // Wrap args in `useMemo` so reference stability prevents infinite refetches.
  const args = useMemo(
    () =>
      ({
        measures: ["arr"] as const,
        dimensions: ["region", "created_at"] as const,
        timeGrain: "month" as const,
        filter: {
          member: "region",
          operator: "in",
          values: ["EMEA", "APAC", "AMER"],
        },
      }) as const,
    [],
  );

  const { data, metadata, loading, error } = useMetricView("revenue", args);

  if (loading) {
    return (
      <div className="text-muted-foreground p-8 text-center">
        Loading revenue metric…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-border bg-muted/40 p-4">
        <p className="font-medium text-foreground">
          Could not load the revenue metric.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          The dev workspace does not host the demo metric view at{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            appkit_demo.public.revenue_metrics
          </code>
          . The typed surface and metadata flow still compile — this panel would
          render a Plotly line chart with{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            $#,##0.00
          </code>{" "}
          tick formatting once the metric view exists in your warehouse.
        </p>
        <p className="mt-3 text-xs font-mono text-destructive">{error}</p>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="text-muted-foreground p-8 text-center">
        No rows returned.
      </div>
    );
  }

  // Group by region — one Plotly trace per series.
  const rows = data as RevenueRow[];
  const byRegion = new Map<string, { x: string[]; y: number[] }>();
  for (const row of rows) {
    if (!byRegion.has(row.region)) {
      byRegion.set(row.region, { x: [], y: [] });
    }
    const entry = byRegion.get(row.region);
    if (!entry) continue;
    entry.x.push(row.created_at);
    entry.y.push(row.arr);
  }

  const traces = Array.from(byRegion.entries()).map(([region, series]) => ({
    type: "scatter" as const,
    mode: "lines+markers" as const,
    name: region,
    x: series.x,
    y: series.y,
    hovertemplate: `<b>${region}</b><br>%{x|%b %Y}<br>%{y}<extra></extra>`,
  }));

  // Wire metadata into Plotly layout. `formatLabel` returns the YAML-defined
  // display name; `toD3Format` converts the YAML's printf-style format spec
  // into the d3-format syntax that Plotly's `tickformat` understands.
  const arrLabel = formatLabel("arr", metadata?.measures.arr);
  const arrTickFormat = toD3Format(metadata?.measures.arr.format);

  return (
    <Plot
      data={traces}
      layout={{
        title: { text: arrLabel },
        xaxis: {
          title: {
            text: formatLabel("created_at", metadata?.dimensions.created_at),
          },
        },
        yaxis: {
          title: { text: arrLabel },
          tickformat: arrTickFormat,
        },
        margin: { t: 40, r: 20, b: 60, l: 80 },
        height: 380,
        autosize: true,
      }}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: "100%" }}
      useResizeHandler
    />
  );
}

function CustomerMetricsPanel({ user }: { user: string | null }) {
  const args = useMemo(
    () =>
      ({
        measures: ["active_accounts", "churn_rate"] as const,
        dimensions: ["segment"] as const,
      }) as const,
    [],
  );

  const { data, metadata, loading, error } = useMetricView(
    "customer_metrics",
    args,
  );

  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        Executing as{" "}
        <code className="rounded bg-muted px-1 py-0.5">
          {user ?? "<unknown user>"}
        </code>
        . OBO entries scope cache keys per user — different users see different
        rows, even with identical args.
      </p>
      {loading && (
        <div className="text-muted-foreground p-4 text-center">
          Loading customer metrics…
        </div>
      )}
      {error && (
        <div className="rounded-md border border-border bg-muted/40 p-4">
          <p className="font-medium text-foreground">
            Could not load customer metrics.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            The dev workspace does not host the demo metric view at{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              appkit_demo.public.customer_metrics
            </code>
            . When wired to a real OBO-lane metric view, this panel would show
            row-level scoping driven by{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              x-forwarded-access-token
            </code>
            .
          </p>
          <p className="mt-3 text-xs font-mono text-destructive">{error}</p>
        </div>
      )}
      {data && data.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left">
              <th className="py-2 pr-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {formatLabel("segment", metadata?.dimensions.segment)}
              </th>
              <th className="py-2 pr-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {formatLabel(
                  "active_accounts",
                  metadata?.measures.active_accounts,
                )}
              </th>
              <th className="py-2 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {formatLabel("churn_rate", metadata?.measures.churn_rate)}
              </th>
            </tr>
          </thead>
          <tbody>
            {(
              data as Array<{
                segment: string;
                active_accounts: number;
                churn_rate: number;
              }>
            ).map((row) => (
              <tr
                key={row.segment}
                className="border-b border-border/60 transition-colors hover:bg-muted/40"
              >
                <td className="py-2.5 pr-4 text-foreground">{row.segment}</td>
                <td className="py-2.5 pr-4 text-right font-mono tabular-nums text-foreground">
                  {formatValue(
                    row.active_accounts,
                    metadata?.measures.active_accounts.format,
                  )}
                </td>
                <td className="py-2.5 text-right font-mono tabular-nums text-foreground">
                  {formatValue(
                    row.churn_rate,
                    metadata?.measures.churn_rate.format,
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function MetricsRoute() {
  const { user } = useWhoami();

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto max-w-6xl px-6 py-12">
        <Header
          title="Metric Views"
          description="UC Metric View consumption with metadata-driven Plotly formatting and OBO row scoping."
          tooltip="Demonstrates useMetricView, formatLabel, formatValue, and toD3Format in a real chart"
        />

        <div className="grid grid-cols-1 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Revenue (SP lane)</CardTitle>
              <CardDescription>
                Annual Recurring Revenue by region, monthly grain. Filter:
                region in {`{EMEA, APAC, AMER}`}. The Y-axis tick format and
                trace name are sourced from the metric view's YAML metadata via{" "}
                <code className="text-xs">toD3Format()</code> and{" "}
                <code className="text-xs">formatLabel()</code>.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RevenueChart />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Customer Metrics (OBO lane)</CardTitle>
              <CardDescription>
                Active accounts and churn rate, grouped by segment. OBO entries
                scope cache keys per requesting user.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CustomerMetricsPanel user={user} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>How this demo wires together</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="list-decimal space-y-2 pl-5 text-sm">
                <li>
                  <code>config/queries/metric.json</code> declares two metric
                  sources — <code>revenue</code> (SP lane) and{" "}
                  <code>customer_metrics</code> (OBO lane).
                </li>
                <li>
                  <code>npx appkit metric sync</code> regenerates a typed{" "}
                  <code>metric.d.ts</code> (augmenting{" "}
                  <code>MetricRegistry</code>) and a{" "}
                  <code>metrics.metadata.json</code> bundle.
                </li>
                <li>
                  <code>main.tsx</code> imports the metadata bundle once at
                  startup and calls <code>registerMetricsMetadata()</code>.
                </li>
                <li>
                  <code>useMetricView(&quot;revenue&quot;, ...)</code> narrows
                  measures, dimensions, and time grains to the registry-known
                  literals — typos fail at compile time.
                </li>
                <li>
                  <code>formatLabel</code>, <code>formatValue</code>, and{" "}
                  <code>toD3Format</code> turn the YAML metadata into Plotly /
                  table-cell strings — no chart-library lock-in.
                </li>
              </ol>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
