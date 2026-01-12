import { createFileRoute, retainSearchParams } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@databricks/appkit-ui/react";
import { useEffect, useState } from "react";
import { Activity, ArrowRight, Loader2 } from "lucide-react";
import { codeToHtml } from "shiki";
import { Header } from "@/components/layout/header";

export const Route = createFileRoute("/telemetry")({
  component: TelemetryRoute,
  search: {
    middlewares: [retainSearchParams(true)],
  },
});

type ExampleResult = {
  success?: boolean;
  error?: boolean;
  message: string;
  result?: unknown;
  duration_ms?: number;
  tracing?: {
    hint: string;
    services?: string[];
    expectedSpans?: string[];
  };
  metrics?: {
    recorded?: string[];
  };
  logs?: {
    emitted?: string[];
  };
  features?: Record<string, string>;
  layers?: Record<string, unknown>;
};

const LAYER_CONFIGS = [
  {
    id: "magic",
    name: "Magic API",
    badge: "Recommended",
    description: "Automatic observability with standard logger methods",
    useCases: [
      "Standard application logging",
      "Request tracing",
      "Error tracking",
      "Performance monitoring",
    ],
    methods: [
      {
        name: "logger.debug()",
        description: "Terminal only (requires DEBUG=appkit:*)",
        outputs: ["Terminal"],
        note: "Local development only",
      },
      {
        name: "logger.trace()",
        description: "Verbose debugging with individual OTEL log records",
        outputs: ["Terminal", "WideEvent.logs[]", "Individual OTEL Log"],
        isNew: true,
        note: "Each trace() creates a separate OTEL log record",
      },
      {
        name: "logger.info()",
        description: "Logs accumulated in WideEvent, sent at request end",
        outputs: ["Terminal", "WideEvent.logs[]", "Span Events"],
        note: "Aggregated in WideEvent → ONE OTEL log per request",
      },
      {
        name: "logger.warn()",
        description: "Warning logs accumulated in WideEvent",
        outputs: ["Terminal", "WideEvent.logs[]", "Span Events"],
        note: "Aggregated in WideEvent → ONE OTEL log per request",
      },
      {
        name: "logger.error()",
        description: "Error logs with exception recording on span",
        outputs: ["Terminal", "WideEvent.logs[]", "Span Events", "Exception"],
        note: "Aggregated in WideEvent → ONE OTEL log per request",
      },
      {
        name: "logger.recordContext()",
        description: "Record metadata without creating log entries",
        outputs: ["WideEvent.context", "Span Attributes"],
        isNew: true,
        note: "Enriches context without cluttering logs array",
      },
    ],
  },
  {
    id: "opinionated",
    name: "Opinionated API",
    badge: "Advanced",
    description: "Custom spans, metrics, and scoping",
    useCases: [
      "Custom trace spans",
      "Business metrics",
      "Performance histograms",
      "Nested scopes",
    ],
    methods: [
      {
        name: "logger.span()",
        description: "Create auto-managed traced spans",
        outputs: ["OTEL Traces", "Auto status/end"],
      },
      {
        name: "logger.counter()",
        description: "Create scoped counter metrics",
        outputs: ["OTEL Metrics"],
      },
      {
        name: "logger.histogram()",
        description: "Create scoped histogram metrics",
        outputs: ["OTEL Metrics"],
      },
      {
        name: "logger.child()",
        description: "Create child logger with nested scope",
        outputs: ["Scoped Logger"],
      },
      {
        name: "logger.getEvent()",
        description: "Access WideEvent for advanced use",
        outputs: ["WideEvent Access"],
      },
    ],
  },
  {
    id: "escape",
    name: "Escape Hatch",
    badge: "Expert",
    description: "Direct OTEL access for advanced features",
    useCases: [
      "Observable gauges (active connections)",
      "Custom tracer names",
      "SpanKind customization",
      "Manual span linking",
    ],
    methods: [
      {
        name: "otel.getTracer()",
        description: "Raw OTEL tracer for full span control",
        outputs: ["Custom Tracers"],
      },
      {
        name: "otel.getMeter()",
        description: "Raw OTEL meter for gauges & observables",
        outputs: ["Observable Instruments"],
      },
      {
        name: "otel.getLogger()",
        description: "Raw OTEL logger (rarely needed)",
        outputs: ["OTEL Logs"],
      },
    ],
  },
];

function CodeSnippet({
  code,
  language = "typescript",
}: {
  code: string;
  language?: string;
}) {
  const [isVisible, setIsVisible] = useState(false);
  const [html, setHtml] = useState("");

  useEffect(() => {
    if (isVisible && !html) {
      codeToHtml(code, {
        lang: language,
        theme: "dark-plus",
      }).then(setHtml);
    }
  }, [isVisible, code, language, html]);

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
          className="mt-2 rounded-md overflow-hidden [&>pre]:m-0 [&>pre]:p-4 [&>pre]:text-sm [&>pre]:overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}

function FlowDiagram({ outputs }: { outputs: string[] }) {
  return (
    <div className="flex items-center gap-2 flex-wrap mt-2">
      {outputs.map((output, idx) => (
        <div key={output} className="flex items-center gap-2">
          {idx > 0 && <ArrowRight className="h-3 w-3 text-gray-400" />}
          <Badge variant="secondary" className="text-xs">
            {output}
          </Badge>
        </div>
      ))}
    </div>
  );
}

function TelemetryRoute() {
  const [loading, setLoading] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ExampleResult>>({});
  const [activeTab, setActiveTab] = useState("overview");

  const runExample = async (
    name: string,
    endpoint: string,
    method: string = "GET",
  ) => {
    setLoading(name);
    setResults((prev) => {
      const newResults = { ...prev };
      delete newResults[name];
      return newResults;
    });

    try {
      const response = await fetch(endpoint, {
        method,
        headers:
          method === "POST" ? { "Content-Type": "application/json" } : {},
        body:
          method === "POST"
            ? JSON.stringify({ userId: "demo-user" })
            : undefined,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type");
      if (!contentType?.includes("application/json")) {
        throw new Error(
          `Expected JSON but got ${contentType}. The endpoint might not be registered.`,
        );
      }

      const data = await response.json();
      setResults((prev) => ({ ...prev, [name]: { ...data, error: false } }));
    } catch (error) {
      setResults((prev) => ({
        ...prev,
        [name]: {
          error: true,
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <Header
          title="Observability Layers"
          description="Three layers of observability APIs: Magic (automatic), Opinionated (custom), and Escape Hatch (direct OTEL)"
          tooltip="Demonstrates the layered observability approach with OpenTelemetry integration"
        />

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-4 mb-8">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="magic">Magic API</TabsTrigger>
            <TabsTrigger value="opinionated">Opinionated</TabsTrigger>
            <TabsTrigger value="escape">Escape Hatch</TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6">
            {/* Layer Comparison Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              {LAYER_CONFIGS.map((layer) => {
                return (
                  <Card
                    key={layer.id}
                    className="hover:shadow-md transition-shadow cursor-pointer"
                    onClick={() => setActiveTab(layer.id)}
                  >
                    <CardHeader>
                      <div className="flex items-center justify-between mb-2">
                        <Badge variant="secondary">{layer.badge}</Badge>
                      </div>
                      <CardTitle>{layer.name}</CardTitle>
                      <CardDescription>{layer.description}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        <h4 className="text-sm font-medium text-muted-foreground">
                          Use Cases:
                        </h4>
                        <ul className="space-y-1">
                          {layer.useCases.map((useCase) => (
                            <li
                              key={useCase}
                              className="text-sm text-foreground"
                            >
                              • {useCase}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <Button
                        variant="ghost"
                        className="w-full mt-4"
                        onClick={() => setActiveTab(layer.id)}
                      >
                        View details
                        <ArrowRight className="h-4 w-4 ml-2" />
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Setup Instructions */}
            <Card className="bg-muted/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5" />
                  Setup: View Telemetry in Grafana
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  To see traces, metrics, and logs, run the Grafana OTEL LGTM
                  stack:
                </p>
                <code className="block bg-gray-900 text-green-400 p-4 rounded-lg text-sm font-mono overflow-x-auto">
                  docker run -p 3000:3000 -p 4317:4317 -p 4318:4318 --rm -ti
                  grafana/otel-lgtm
                </code>
                <div className="text-sm text-muted-foreground">
                  Access Grafana at{" "}
                  <a
                    href="http://localhost:3000"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline hover:text-primary/80"
                  >
                    http://localhost:3000
                  </a>{" "}
                  (Explore → Tempo for traces, Prometheus for metrics, Loki for
                  logs)
                </div>
              </CardContent>
            </Card>

            {/* Live Demo */}
            <Card>
              <CardHeader>
                <CardTitle>Live Example</CardTitle>
                <CardDescription>
                  Demonstrates all three layers working together. Run twice to
                  see cache behavior.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="bg-muted p-4 rounded-lg border">
                  <h4 className="font-medium text-sm mb-2">
                    What this example does:
                  </h4>
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    <li>
                      • Uses{" "}
                      <code className="bg-background px-1 rounded">
                        logger.info()
                      </code>{" "}
                      for automatic observability
                    </li>
                    <li>
                      • Creates custom spans with{" "}
                      <code className="bg-background px-1 rounded">
                        logger.span()
                      </code>
                    </li>
                    <li>
                      • Uses raw OTEL for observable gauges (escape hatch)
                    </li>
                  </ul>
                </div>

                <Button
                  onClick={() =>
                    runExample(
                      "combined",
                      "/api/telemetry-examples/combined",
                      "POST",
                    )
                  }
                  disabled={loading === "combined"}
                  className="w-full"
                  size="lg"
                >
                  {loading === "combined" ? (
                    <>
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                      Running Example...
                    </>
                  ) : (
                    <>
                      <Activity className="mr-2 h-5 w-5" />
                      Run Combined Example
                    </>
                  )}
                </Button>

                {results.combined && (
                  <div
                    className={`p-5 rounded-lg border ${
                      results.combined.error
                        ? "bg-destructive/10 border-destructive"
                        : "bg-muted"
                    }`}
                  >
                    <div className="space-y-4">
                      <div
                        className={`font-semibold text-base ${
                          results.combined.error
                            ? "text-destructive"
                            : "text-foreground"
                        }`}
                      >
                        {results.combined.error ? "Error" : "Success"}
                      </div>

                      {results.combined.duration_ms && (
                        <div className="text-muted-foreground font-medium text-sm">
                          Duration: {results.combined.duration_ms}ms
                        </div>
                      )}

                      {results.combined.tracing && (
                        <div className="bg-background rounded border p-4">
                          <div className="font-semibold text-foreground mb-3">
                            Tracing
                          </div>
                          {results.combined.tracing.expectedSpans && (
                            <div className="text-xs text-muted-foreground font-mono whitespace-pre-wrap bg-muted p-3 rounded">
                              {results.combined.tracing.expectedSpans.join(
                                "\n",
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {results.combined.metrics && (
                        <div className="bg-background rounded border p-4">
                          <div className="font-semibold text-foreground mb-3">
                            Metrics
                          </div>
                          {results.combined.metrics.recorded && (
                            <ul className="space-y-1">
                              {results.combined.metrics.recorded.map((m) => (
                                <li
                                  key={m}
                                  className="text-sm text-muted-foreground"
                                >
                                  • {m}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}

                      {results.combined.logs && (
                        <div className="bg-background rounded border p-4">
                          <div className="font-semibold text-foreground mb-3">
                            Logs
                          </div>
                          {results.combined.logs.emitted && (
                            <ul className="space-y-1">
                              {results.combined.logs.emitted.map((m) => (
                                <li
                                  key={m}
                                  className="text-sm text-muted-foreground"
                                >
                                  • {m}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Magic API Tab */}
          <TabsContent value="magic" className="space-y-6">
            {(() => {
              const layer = LAYER_CONFIGS[0];
              return (
                <>
                  <Card>
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <div>
                          <CardTitle>{layer.name}</CardTitle>
                          <CardDescription>{layer.description}</CardDescription>
                        </div>
                        <Badge variant="secondary">{layer.badge}</Badge>
                      </div>
                    </CardHeader>
                  </Card>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {layer.methods.map((method) => (
                      <Card key={method.name}>
                        <CardHeader>
                          <div className="flex items-center justify-between">
                            <code className="text-base font-bold">
                              {method.name}
                            </code>
                            {"isNew" in method && method.isNew && (
                              <Badge variant="default">NEW</Badge>
                            )}
                          </div>
                          <CardDescription>
                            {method.description}
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-3">
                            <h4 className="text-sm font-medium text-muted-foreground">
                              Output Flow:
                            </h4>
                            <FlowDiagram outputs={method.outputs} />
                            {"note" in method && method.note && (
                              <div className="mt-3 p-2 bg-muted border rounded text-xs text-muted-foreground">
                                {method.note}
                              </div>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>

                  {/* WideEvent Explanation */}
                  <Card className="bg-muted/50">
                    <CardHeader>
                      <CardTitle>Understanding WideEvent Aggregation</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="bg-background rounded-lg p-4 border">
                        <h4 className="font-semibold text-foreground mb-3">
                          How Logs Flow:
                        </h4>
                        <div className="space-y-3 text-sm">
                          <div className="flex items-start gap-3">
                            <div className="font-mono bg-muted px-2 py-1 rounded shrink-0">
                              1
                            </div>
                            <div>
                              <span className="font-semibold">
                                During Request:
                              </span>{" "}
                              Each{" "}
                              <code className="bg-muted px-1">
                                logger.info()
                              </code>{" "}
                              accumulates in{" "}
                              <code className="bg-muted px-1">
                                WideEvent.logs[]
                              </code>{" "}
                              (in memory)
                            </div>
                          </div>
                          <div className="flex items-start gap-3">
                            <div className="font-mono bg-muted px-2 py-1 rounded shrink-0">
                              2
                            </div>
                            <div>
                              <span className="font-semibold">
                                At Request End:
                              </span>{" "}
                              Entire WideEvent sent as{" "}
                              <span className="font-semibold">ONE</span> OTEL
                              log record
                            </div>
                          </div>
                          <div className="flex items-start gap-3">
                            <div className="font-mono bg-muted px-2 py-1 rounded shrink-0">
                              3
                            </div>
                            <div>
                              <span className="font-semibold">In Loki:</span>{" "}
                              Query for request_id → see the full WideEvent JSON
                              with all logs inside
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="bg-background rounded-lg p-4 border">
                        <h4 className="font-semibold text-foreground mb-2">
                          Why This Design?
                        </h4>
                        <ul className="space-y-2 text-sm text-muted-foreground">
                          <li>
                            • <strong>Request correlation:</strong> All logs
                            from one request stay together
                          </li>
                          <li>
                            • <strong>Efficient:</strong> One network call per
                            request (not per log)
                          </li>
                          <li>
                            • <strong>Rich metadata:</strong> WideEvent includes
                            execution, errors, duration, user context
                          </li>
                          <li>
                            • <strong>Production debugging:</strong> "Show me
                            everything for request abc123"
                          </li>
                        </ul>
                      </div>

                      <div className="bg-background rounded-lg p-4 border">
                        <h4 className="font-semibold text-foreground mb-2">
                          The Three Destinations
                        </h4>
                        <div className="space-y-2 text-sm text-muted-foreground">
                          <div>
                            <strong>1. Terminal:</strong> Individual logs for
                            local debugging (DEBUG=appkit:*)
                          </div>
                          <div>
                            <strong>2. Span Events (Tempo):</strong> Individual
                            events attached to trace timeline
                          </div>
                          <div>
                            <strong>3. WideEvent → OTEL Logs (Loki):</strong>{" "}
                            ONE aggregated record per request
                          </div>
                          <div className="mt-2 pt-2 border-t">
                            <strong>Exception:</strong>{" "}
                            <code className="bg-muted px-1">
                              logger.trace()
                            </code>{" "}
                            sends individual OTEL log records (not aggregated)
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Code Examples */}
                  <Card>
                    <CardHeader>
                      <CardTitle>Code Examples</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      <div>
                        <h4 className="font-semibold mb-2">
                          Basic Logging (Most Common)
                        </h4>
                        <p className="text-sm text-gray-600 mb-3">
                          Just call logger methods - logs accumulate in
                          WideEvent:
                        </p>
                        <CodeSnippet
                          code={`// Flows to: Terminal + WideEvent.logs[] + Span Events
logger.info("Processing user request", {
  userId: "123",
  action: "purchase"
});

// Log warnings with context
logger.warn("Cache miss detected", {
  cacheKey: "user:123",
  ttl: 60
});

// Log errors with automatic exception recording
logger.error("Payment failed", error, {
  paymentId: "pay_123",
  amount: 99.99
});

// At request end → WideEvent sent to OTEL Logs as ONE record`}
                        />
                      </div>

                      <div>
                        <h4 className="font-semibold mb-2">
                          NEW: Verbose Debugging (logger.trace)
                        </h4>
                        <p className="text-sm text-gray-600 mb-3">
                          Unlike debug(), trace() sends individual OTEL log
                          records (not aggregated):
                        </p>
                        <CodeSnippet
                          code={`// Each trace() → separate OTEL log record (queryable immediately)
logger.trace("Starting complex workflow", {
  workflowId: "wf_123",
  step: "init",
  timestamp: new Date().toISOString()
});

// Unlike info/warn/error, trace logs are NOT aggregated
// Each one is a separate record in Loki/OTEL backend
logger.trace("Received webhook payload", {
  source: "stripe",
  eventType: "payment_intent.succeeded",
  payload: JSON.stringify(data)
});`}
                        />
                      </div>

                      <div>
                        <h4 className="font-semibold mb-2">
                          NEW: Record Context Without Logs
                        </h4>
                        <p className="text-sm text-gray-600 mb-3">
                          Enrich traces with metadata without cluttering logs:
                        </p>
                        <CodeSnippet
                          code={`// Add metadata to WideEvent and Span without log entry
logger.recordContext({
  operationId: crypto.randomUUID(),
  warehouseId: "wh-abc123",
  userId: "user-456"
});

// This enriches your traces but doesn't create log lines
// Perfect for IDs, hashes, and computed values`}
                        />
                      </div>

                      <div>
                        <h4 className="font-semibold mb-2">
                          NEW: Expected Errors (Don't Fail Span)
                        </h4>
                        <p className="text-sm text-gray-600 mb-3">
                          Log errors with graceful fallbacks without marking
                          span as failed:
                        </p>
                        <CodeSnippet
                          code={`try {
  return await fetch(externalApi);
} catch (error) {
  // This is expected - we have a fallback
  logger.error(
    "External API unavailable, using cache",
    error,
    { api: externalApi },
    { recordOnSpan: false } // Don't fail the span
  );
  return cachedData;
}`}
                        />
                      </div>

                      <div>
                        <h4 className="font-semibold mb-2">
                          What WideEvent Looks Like in OTEL Logs
                        </h4>
                        <p className="text-sm text-gray-600 mb-3">
                          In Loki/OTEL backend, you see ONE record per request:
                        </p>
                        <CodeSnippet
                          language="json"
                          code={`{
  "request_id": "abc123",
  "method": "POST",
  "path": "/api/analytics/query",
  "status_code": 200,
  "duration_ms": 234,
  "plugin": { "name": "analytics", "operation": "query" },
  "execution": { "cache_hit": true, "cache_key": "user_data..." },
  "context": {
    "sql-warehouse": { "warehouse_id": "xyz", "rows_returned": 150 }
  },
  "logs": [
    { "level": "info", "message": "Processing query", "context": {...} },
    { "level": "info", "message": "Cache hit", "context": {...} },
    { "level": "info", "message": "Query completed", "context": {...} }
  ]
}

// ☝️ All 3 logger.info() calls are inside this ONE WideEvent record`}
                        />
                      </div>
                    </CardContent>
                  </Card>
                </>
              );
            })()}
          </TabsContent>

          {/* Opinionated API Tab */}
          <TabsContent value="opinionated" className="space-y-6">
            {(() => {
              const layer = LAYER_CONFIGS[1];
              return (
                <>
                  <Card>
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <div>
                          <CardTitle>{layer.name}</CardTitle>
                          <CardDescription>{layer.description}</CardDescription>
                        </div>
                        <Badge variant="secondary">{layer.badge}</Badge>
                      </div>
                    </CardHeader>
                  </Card>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {layer.methods.map((method) => (
                      <Card key={method.name}>
                        <CardHeader>
                          <code className="text-base font-bold">
                            {method.name}
                          </code>
                          <CardDescription>
                            {method.description}
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-3">
                            <h4 className="text-sm font-medium text-muted-foreground">
                              Provides:
                            </h4>
                            <FlowDiagram outputs={method.outputs} />
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>

                  {/* Code Examples */}
                  <Card>
                    <CardHeader>
                      <CardTitle>Code Examples</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      <div>
                        <h4 className="font-semibold mb-2">
                          Custom Traced Spans
                        </h4>
                        <p className="text-sm text-gray-600 mb-3">
                          Create spans that are automatically managed (no need
                          to call span.end()):
                        </p>
                        <CodeSnippet
                          code={`// Span is auto-ended and status is auto-set
await logger.span("fetch-user-data", async (span) => {
  span.setAttribute("db.system", "databricks");
  span.setAttribute("user.id", userId);

  const data = await fetchFromDB(userId);

  span.addEvent("data_fetched", {
    records: data.length
  });

  return data;
  // ✅ Span automatically ends with OK status
  // ✅ If error thrown, span ends with ERROR status
});`}
                        />
                      </div>

                      <div>
                        <h4 className="font-semibold mb-2">Business Metrics</h4>
                        <p className="text-sm text-gray-600 mb-3">
                          Track counters and histograms scoped to your plugin:
                        </p>
                        <CodeSnippet
                          code={`// Create metrics (typically in constructor)
private requestCounter = this.logger.counter("requests.total", {
  description: "Total requests processed"
});

private durationHistogram = this.logger.histogram("request.duration", {
  description: "Request duration",
  unit: "ms"
});

// Record values
this.requestCounter.add(1, { status: "success", route: "/api/users" });
this.durationHistogram.record(duration, { endpoint: "/api/users" });`}
                        />
                      </div>

                      <div>
                        <h4 className="font-semibold mb-2">
                          Nested Logger Scopes
                        </h4>
                        <p className="text-sm text-gray-600 mb-3">
                          Create child loggers for better log organization:
                        </p>
                        <CodeSnippet
                          code={`// Parent logger scope: "analytics"
const parentLogger = LoggerManager.getLogger("analytics");

// Child logger scope: "analytics:query"
const queryLogger = parentLogger.child("query");

// Child logger scope: "analytics:cache"
const cacheLogger = parentLogger.child("cache");

// Logs are now organized by nested scope
queryLogger.info("Query executed"); // Scope: analytics:query
cacheLogger.info("Cache hit");      // Scope: analytics:cache`}
                        />
                      </div>

                      <div>
                        <h4 className="font-semibold mb-2">
                          Access WideEvent (Advanced)
                        </h4>
                        <p className="text-sm text-gray-600 mb-3">
                          Get direct access to WideEvent for advanced use cases:
                        </p>
                        <CodeSnippet
                          code={`// Get the current request's WideEvent
const event = logger.getEvent();

if (event) {
  // Add custom context
  event.setContext("custom", {
    correlationId: "abc-123"
  });

  // Add custom log
  event.addLog("info", "Custom event logged", {
    source: "my-plugin"
  });
}`}
                        />
                      </div>
                    </CardContent>
                  </Card>
                </>
              );
            })()}
          </TabsContent>

          {/* Escape Hatch Tab */}
          <TabsContent value="escape" className="space-y-6">
            {(() => {
              const layer = LAYER_CONFIGS[2];
              return (
                <>
                  <Card>
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <div>
                          <CardTitle>{layer.name}</CardTitle>
                          <CardDescription>{layer.description}</CardDescription>
                        </div>
                        <Badge variant="secondary">{layer.badge}</Badge>
                      </div>
                    </CardHeader>
                  </Card>

                  <Card className="bg-muted/50">
                    <CardHeader>
                      <CardTitle>When to Use the Escape Hatch</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground mb-3">
                        Use the escape hatch when you need OTEL features not
                        available in Magic or Opinionated APIs:
                      </p>
                      <ul className="space-y-2 text-sm text-foreground">
                        {layer.useCases.map((useCase) => (
                          <li key={useCase}>• {useCase}</li>
                        ))}
                      </ul>
                      <p className="text-sm text-muted-foreground mt-3">
                        Note: The Magic API is sufficient for most use cases.
                      </p>
                    </CardContent>
                  </Card>

                  <div className="grid grid-cols-1 gap-6">
                    {layer.methods.map((method) => (
                      <Card key={method.name}>
                        <CardHeader>
                          <code className="text-base font-bold">
                            {method.name}
                          </code>
                          <CardDescription>
                            {method.description}
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-3">
                            <h4 className="text-sm font-medium text-muted-foreground">
                              Provides:
                            </h4>
                            <FlowDiagram outputs={method.outputs} />
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>

                  {/* Code Examples */}
                  <Card>
                    <CardHeader>
                      <CardTitle>Code Examples</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      <div>
                        <h4 className="font-semibold mb-2">
                          Custom Tracer Names
                        </h4>
                        <p className="text-sm text-gray-600 mb-3">
                          When you need tracer names not scoped to your plugin:
                        </p>
                        <CodeSnippet
                          code={`import { otel } from "@databricks/appkit";

// Get a custom tracer (not scoped to plugin name)
const tracer = otel.getTracer("custom-service-name");

// Create spans with full control
await tracer.startActiveSpan("custom-operation", async (span) => {
  span.setAttribute("custom.attribute", "value");
  span.setStatus({ code: SpanStatusCode.OK });

  // You must manually end the span
  span.end();
});`}
                        />
                      </div>

                      <div>
                        <h4 className="font-semibold mb-2">
                          Observable Gauges
                        </h4>
                        <p className="text-sm text-gray-600 mb-3">
                          For metrics that need callbacks (not available in
                          logger.counter/histogram):
                        </p>
                        <CodeSnippet
                          code={`import { otel } from "@databricks/appkit";

// Get raw OTEL meter
const meter = otel.getMeter("my-meter");

// Create observable gauge (requires callback)
const activeConnections = meter.createObservableGauge(
  "app.connections.active",
  {
    description: "Number of active connections",
    unit: "connections"
  }
);

// Register callback
activeConnections.addCallback((result) => {
  // Read from your connection pool
  const count = connectionPool.getActiveCount();
  result.observe(count);
});`}
                        />
                      </div>

                      <div>
                        <h4 className="font-semibold mb-2">
                          SpanKind Customization
                        </h4>
                        <p className="text-sm text-gray-600 mb-3">
                          Set specific span kinds (CLIENT, SERVER, PRODUCER,
                          CONSUMER):
                        </p>
                        <CodeSnippet
                          code={`import { otel } from "@databricks/appkit";
import { SpanKind } from "@opentelemetry/api";

const tracer = otel.getTracer("my-service");

// Create CLIENT span for outgoing HTTP
await tracer.startActiveSpan(
  "http-request",
  {
    kind: SpanKind.CLIENT,
    attributes: {
      "http.method": "GET",
      "http.url": "https://api.example.com"
    }
  },
  async (span) => {
    await fetch("https://api.example.com");
    span.end();
  }
);`}
                        />
                      </div>

                      <div>
                        <h4 className="font-semibold mb-2">Combining Layers</h4>
                        <p className="text-sm text-gray-600 mb-3">
                          You can use escape hatch alongside Magic API:
                        </p>
                        <CodeSnippet
                          code={`import { otel } from "@databricks/appkit";

const tracer = otel.getTracer("advanced-service");

await tracer.startActiveSpan("custom-span", async (span) => {
  // Use escape hatch for span control
  span.setAttribute("custom.id", "123");

  // Still use Magic API inside!
  this.logger.info("Processing inside custom span", {
    spanId: span.spanContext().spanId
  });

  // Use Opinionated API for metrics
  this.requestCounter.add(1);

  span.end();
});`}
                        />
                      </div>
                    </CardContent>
                  </Card>

                  {/* Demo Button */}
                  <Card>
                    <CardHeader>
                      <CardTitle>Try Escape Hatch Example</CardTitle>
                      <CardDescription>
                        This example uses raw OTEL APIs to create observable
                        gauges
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Button
                        onClick={() =>
                          runExample(
                            "escape",
                            "/api/telemetry-examples/advanced-otel",
                            "POST",
                          )
                        }
                        disabled={loading === "escape"}
                        className="w-full"
                        size="lg"
                      >
                        {loading === "escape" ? (
                          <>
                            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                            Running...
                          </>
                        ) : (
                          "Run Escape Hatch Example"
                        )}
                      </Button>

                      {results.escape && (
                        <div className="mt-4 p-4 bg-muted border rounded-lg">
                          <pre className="text-xs text-foreground whitespace-pre-wrap">
                            {JSON.stringify(results.escape, null, 2)}
                          </pre>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </>
              );
            })()}
          </TabsContent>
        </Tabs>

        {/* Decision Tree */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>Which Layer Should I Use?</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-3 bg-muted rounded-lg">
                <div>
                  <div className="font-semibold text-foreground">
                    Start with Magic API
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Use logger.info(), logger.warn(), logger.error() for most
                    logging needs. It automatically flows everywhere.
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 bg-muted rounded-lg">
                <div>
                  <div className="font-semibold text-foreground">
                    Use Opinionated API when you need:
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Custom spans (logger.span), business metrics
                    (logger.counter/histogram), or nested scopes (logger.child).
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 bg-muted rounded-lg">
                <div>
                  <div className="font-semibold text-foreground">
                    Use Escape Hatch only when you need:
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Observable gauges, custom tracer names, SpanKind
                    customization, or other advanced OTEL features not in other
                    layers.
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
