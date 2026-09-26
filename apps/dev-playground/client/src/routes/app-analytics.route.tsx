import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@databricks/appkit-ui/react";
import { appAnalytics } from "@databricks/appkit-ui/react/beta";
import { createFileRoute, retainSearchParams } from "@tanstack/react-router";
import {
  FileTextIcon,
  LayersIcon,
  Loader2,
  MousePointerClickIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { Header } from "@/components/layout/header";
import {
  clearDiagnostics,
  type RecordedDiagnostic,
  useDiagnostics,
} from "@/lib/app-analytics-diagnostics";

export const Route = createFileRoute("/app-analytics")({
  component: AppAnalyticsRoute,
  search: {
    middlewares: [retainSearchParams(true)],
  },
});

const TRACK_EVENT_NAME = "playground_event_tracked";
const BURST_EVENT_NAME = "playground_burst_tracked";
const AUTOCAPTURE_EVENT_NAME = "playground_autocapture_clicked";
const BURST_SIZE = 30;

function AppAnalyticsRoute() {
  const diagnostics = useDiagnostics();
  const [recorded, setRecorded] = useState(0);
  const [flushing, setFlushing] = useState(false);
  const [lastFlushAt, setLastFlushAt] = useState<string | null>(null);

  const track = () => {
    appAnalytics.track(TRACK_EVENT_NAME, { source: "track_button" });
    setRecorded((count) => count + 1);
  };

  const pageView = () => {
    appAnalytics.page({ section: "app_analytics" });
    setRecorded((count) => count + 1);
  };

  const queueBurst = () => {
    for (let index = 0; index < BURST_SIZE; index += 1) {
      appAnalytics.track(BURST_EVENT_NAME, {
        burst_index: index + 1,
        burst_size: BURST_SIZE,
      });
    }
    setRecorded((count) => count + BURST_SIZE);
  };

  const flush = async () => {
    setFlushing(true);
    try {
      await appAnalytics.flush();
      setLastFlushAt(new Date().toLocaleTimeString());
    } finally {
      setFlushing(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <Header
          title="App Analytics"
          description="Browser usage and experience telemetry, relayed by the AppKit server to the Databricks Apps OTel Collector."
          tooltip="<AppAnalytics /> is mounted once in the root layout with webVitals and autocapture on. Events post to the server plugin's built-in /_analytics/v1/logs relay."
        />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Record events</CardTitle>
              <CardDescription>
                The SDK batches events and sends them after 25 events, every
                five seconds, or when you flush. Open DevTools and filter the
                network panel by <code>/_analytics/v1/logs</code>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex flex-wrap gap-3">
                <Button onClick={track}>
                  <SendIcon className="h-4 w-4 mr-2" />
                  Track
                </Button>
                <Button variant="outline" onClick={pageView}>
                  <FileTextIcon className="h-4 w-4 mr-2" />
                  Page view
                </Button>
                <Button variant="outline" onClick={queueBurst}>
                  <LayersIcon className="h-4 w-4 mr-2" />
                  Queue {BURST_SIZE}
                </Button>
                <Button variant="secondary" onClick={flush} disabled={flushing}>
                  {flushing ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : null}
                  Flush
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
                <span>
                  Recorded on this page:{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {recorded}
                  </span>
                </span>
                <span>
                  Last flush:{" "}
                  <span className="font-medium text-foreground">
                    {lastFlushAt ?? "not yet"}
                  </span>
                </span>
              </div>

              <div className="rounded-md border p-4 space-y-3">
                <p className="text-sm text-muted-foreground">
                  Autocapture records clicks on elements annotated with{" "}
                  <code>data-app-analytics-event</code>. No text or DOM content
                  is collected.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  data-app-analytics-event={AUTOCAPTURE_EVENT_NAME}
                  onClick={() => setRecorded((count) => count + 1)}
                >
                  <MousePointerClickIcon className="h-4 w-4 mr-2" />
                  Annotated button
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Where records go</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="list-decimal pl-5 space-y-2 text-sm text-muted-foreground">
                <li>
                  The browser posts OTLP/HTTP JSON to{" "}
                  <code>/_analytics/v1/logs</code> on this origin.
                </li>
                <li>
                  The AppKit server relays the payload unchanged to{" "}
                  <code>OTEL_EXPORTER_OTLP_ENDPOINT</code>/v1/logs.
                </li>
                <li>
                  With App telemetry enabled, records land in the app's{" "}
                  <code>otel_logs</code> table.
                </li>
              </ol>
              <p className="text-sm text-muted-foreground mt-4">
                Without an OTLP endpoint (for example in local dev), the relay
                answers <code>204</code> and discards the records.
              </p>
            </CardContent>
          </Card>
        </div>

        <Card className="mt-6">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div className="space-y-1.5">
              <CardTitle>Diagnostics</CardTitle>
              <CardDescription>
                Delivery problems reported through <code>onDiagnostic</code>.
                Diagnostics never include event content.
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearDiagnostics}
              disabled={diagnostics.length === 0}
            >
              <Trash2Icon className="h-4 w-4 mr-2" />
              Clear
            </Button>
          </CardHeader>
          <CardContent>
            {diagnostics.length === 0 ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="app-analytics-no-diagnostics"
              >
                No diagnostics. Every batch so far was accepted.
              </p>
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {diagnostics.map((diagnostic, index) => (
                  <DiagnosticRow
                    key={`${diagnostic.receivedAt}-${index}`}
                    diagnostic={diagnostic}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DiagnosticRow({ diagnostic }: { diagnostic: RecordedDiagnostic }) {
  const details = [
    `${diagnostic.eventCount} event${diagnostic.eventCount === 1 ? "" : "s"}`,
    diagnostic.reason,
    diagnostic.status === undefined ? undefined : `HTTP ${diagnostic.status}`,
    diagnostic.attempt === undefined
      ? undefined
      : `attempt ${diagnostic.attempt}`,
  ].filter((detail): detail is string => detail !== undefined);

  return (
    <li className="flex items-center justify-between gap-4 px-3 py-2">
      <div className="flex items-center gap-3 min-w-0">
        <Badge variant="outline" className="font-mono">
          {diagnostic.code}
        </Badge>
        <span className="text-muted-foreground truncate">
          {details.join(" · ")}
        </span>
      </div>
      <span className="text-xs text-muted-foreground tabular-nums shrink-0">
        {new Date(diagnostic.receivedAt).toLocaleTimeString()}
      </span>
    </li>
  );
}
