import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  useAnalyticsQuery,
} from "@databricks/appkit-ui/react";
import { createFileRoute, retainSearchParams } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Header } from "@/components/layout/header";

export const Route = createFileRoute("/query-dedup")({
  component: QueryDedupRoute,
  search: {
    middlewares: [retainSearchParams(true)],
  },
});

// Two zero-parameter queries. Panels on the same key share one request; the
// key toggle demonstrates that a *different* key opens its own request.
const QUERY_KEYS = ["apps_list", "example"] as const;
type DemoQueryKey = (typeof QUERY_KEYS)[number];
const ANALYTICS_PATH = "/api/analytics/query/";

/**
 * Route-local counter for analytics network requests. Wraps `window.fetch`
 * while this route is mounted (restored on unmount) and counts POSTs to the
 * analytics query endpoint. This is what makes dedup observable in-page
 * instead of only in the DevTools Network tab — it counts the real transport
 * calls `useAnalyticsQuery` makes, without instrumenting the hook itself.
 */
const requestCounter = (() => {
  let count = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    increment() {
      count += 1;
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get() {
      return count;
    },
  };
})();

/** Install the fetch wrapper for the lifetime of the route. */
function useAnalyticsRequestCounter(): number {
  useEffect(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes(ANALYTICS_PATH) && init?.method === "POST") {
        requestCounter.increment();
      }
      return original(input, init);
    };
    return () => {
      window.fetch = original;
    };
  }, []);

  return useSyncExternalStore(
    requestCounter.subscribe,
    requestCounter.get,
    requestCounter.get,
  );
}

/**
 * A single independent consumer of a shared query. Each mounted panel is a
 * separate `useAnalyticsQuery` hook instance — without dedup, each would fire
 * its own request.
 */
function Panel({ label, queryKey }: { label: string; queryKey: DemoQueryKey }) {
  const { data, loading, error } = useAnalyticsQuery(queryKey, {});
  const rows = Array.isArray(data) ? data.length : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          <span>Panel {label}</span>
          {loading ? (
            <Badge variant="secondary">loading…</Badge>
          ) : error ? (
            <Badge variant="destructive">error</Badge>
          ) : (
            <Badge variant="outline">{rows} rows</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="font-mono text-sm text-muted-foreground">
        useAnalyticsQuery("{queryKey}")
      </CardContent>
    </Card>
  );
}

const PANEL_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];

function QueryDedupRoute() {
  const requestCount = useAnalyticsRequestCounter();
  const [panelCount, setPanelCount] = useState(4);
  // When true, the last panel switches to a different query key, so it can no
  // longer share the request — the counter ticks up to prove distinct keys
  // still fan out independently.
  const [splitLast, setSplitLast] = useState(false);

  const labels = PANEL_LABELS.slice(0, panelCount);
  const distinctKeys = splitLast && panelCount > 1 ? 2 : 1;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1200px] mx-auto px-6 py-12">
        <Header
          title="Query Deduplication"
          description="Multiple components requesting the same analytics query share a single in-flight request."
          tooltip="Each panel calls useAnalyticsQuery with a query key and parameters. Panels sharing a key resolve to one request instead of one per panel."
        />

        <Card className="mb-6">
          <CardContent className="flex flex-wrap items-center gap-6 py-6">
            <div>
              <div className="text-3xl font-bold text-foreground">
                {panelCount}
              </div>
              <div className="text-sm text-muted-foreground">
                components mounted
              </div>
            </div>
            <div className="text-2xl text-muted-foreground">→</div>
            <div>
              <div className="text-3xl font-bold text-foreground">
                {requestCount}
              </div>
              <div className="text-sm text-muted-foreground">
                network request{requestCount === 1 ? "" : "s"} fired
              </div>
            </div>
            <div className="text-sm text-muted-foreground">
              {distinctKeys === 1 ? (
                <>
                  All {panelCount} panels share one key — without dedup this
                  would be{" "}
                  <span className="font-semibold text-foreground">
                    {panelCount}
                  </span>{" "}
                  requests.
                </>
              ) : (
                <>
                  Two distinct keys in use → two requests, no matter how many
                  panels share each.
                </>
              )}
            </div>
            <div className="ml-auto flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setPanelCount((c) => Math.min(c + 1, PANEL_LABELS.length))
                }
                disabled={panelCount >= PANEL_LABELS.length}
              >
                Mount another panel
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSplitLast((s) => !s)}
                disabled={panelCount < 2}
              >
                {splitLast ? "Rejoin last panel" : "Give last panel a new key"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {labels.map((label, i) => {
            const isSplit = splitLast && i === labels.length - 1;
            return (
              <Panel
                key={label}
                label={label}
                queryKey={isSplit ? QUERY_KEYS[1] : QUERY_KEYS[0]}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
