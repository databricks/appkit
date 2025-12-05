import { createFileRoute, retainSearchParams } from "@tanstack/react-router";
import { Activity, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

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
};

function TelemetryRoute() {
  const [loading, setLoading] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ExampleResult>>({});

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
            ? JSON.stringify({ items: [1, 2, 3, 4, 5] })
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

  const examples = [
    {
      id: "combined",
      title: "Custom plugin example",
      description: (
        <>
          <p className="mb-2">
            Demonstrates SDK auto-instrumentation for HTTP requests and caching,
            combined with custom tracing, metrics, and structured logging.
          </p>
          <p className="mb-2">Run twice to see cache behavior in action.</p>
          <p>Observe results in Grafana.</p>
        </>
      ),
      endpoint: "/api/telemetry-examples/combined",
      method: "POST",
      icon: Activity,
    },
  ];

  return (
    <div className="min-h-[calc(100vh-73px)] bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Telemetry Demo
          </h1>
          <p className="text-base text-gray-500">
            Demonstrates how the SDK's auto-instrumentation integrates with
            custom application telemetry. This example showcases HTTP and cache
            instrumentation from the SDK, alongside custom tracing, metrics, and
            structured logs.
          </p>
        </div>

        <Card className="p-6 mb-6">
          <h3 className="text-xl font-semibold mb-3">
            View Traces, Metrics & Logs in Grafana
          </h3>
          <p className="text-sm text-gray-600 mb-4">
            Ensure telemetry is enabled and the <code>grafana/otel-lgtm</code>{" "}
            container is running:
          </p>
          <code className="block bg-gray-800 text-green-400 p-3 rounded text-sm font-mono mb-4 overflow-x-auto">
            docker run -p 3000:3000 -p 4317:4317 -p 4318:4318 --rm -ti
            grafana/otel-lgtm
          </code>
          <p className="text-sm text-gray-600 mb-4">
            Access Grafana at{" "}
            <a
              href="http://localhost:3000"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 underline hover:text-blue-800"
            >
              http://localhost:3000
            </a>{" "}
            to view traces, metrics, and logs (use Explore with Tempo for
            traces, Prometheus for metrics, and Loki for logs).
          </p>
        </Card>

        {examples.map((example) => {
          const result = results[example.id];
          const isLoading = loading === example.id;
          const Icon = example.icon;

          return (
            <Card key={example.id} className="p-6">
              <h2 className="text-2xl font-bold mb-6">{example.title}</h2>

              <div className="grid lg:grid-cols-2 gap-6 mb-6">
                <div className="flex items-start gap-4">
                  <div className="p-4 bg-blue-100 rounded-lg flex-shrink-0">
                    <Icon className="h-8 w-8 text-blue-600" />
                  </div>
                  <div className="flex-1">
                    <div className="text-sm text-gray-500">
                      {example.description}
                    </div>
                  </div>
                </div>

                <div className="space-y-6">
                  <code className="block bg-gray-800 text-green-400 p-4 rounded text-sm font-mono overflow-x-auto">
                    curl -X POST
                    http://localhost:8000/api/telemetry-examples/combined \
                    {"\n"}
                    {"  "}-H "Content-Type: application/json" \{"\n"}
                    {"  "}-d '{"{"}"userId":"test-user"{"}"}'
                  </code>

                  <Button
                    onClick={() =>
                      runExample(example.id, example.endpoint, example.method)
                    }
                    disabled={isLoading}
                    className="w-full"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Running...
                      </>
                    ) : (
                      `Run ${example.method === "POST" ? "POST" : "GET"} Request`
                    )}
                  </Button>
                </div>
              </div>

              {result && (
                <div
                  className={`p-5 rounded-lg border ${
                    result.error
                      ? "bg-red-50 border-red-200"
                      : "bg-green-50 border-green-200"
                  }`}
                >
                  <div className="space-y-3">
                    <div
                      className={`font-semibold text-base ${
                        result.error ? "text-red-700" : "text-green-700"
                      }`}
                    >
                      {result.error ? "Error" : "Success"}:{" "}
                    </div>

                    {result.duration_ms && (
                      <div className="text-gray-700 font-medium text-sm">
                        Duration: {result.duration_ms}ms
                      </div>
                    )}

                    {result.tracing && (
                      <div className="bg-white rounded border border-gray-200 p-4">
                        <div className="font-semibold text-gray-900 mb-3">
                          Tracing
                        </div>
                        {result.tracing.services && (
                          <div className="text-sm text-gray-600 mb-2">
                            <strong>Services:</strong>{" "}
                            {result.tracing.services.length}
                          </div>
                        )}
                        {result.tracing.expectedSpans && (
                          <div className="text-xs text-gray-700 font-mono whitespace-pre-wrap bg-gray-50 p-3 rounded mb-2">
                            {result.tracing.expectedSpans.join("\n")}
                          </div>
                        )}
                      </div>
                    )}

                    {result.metrics && (
                      <div className="bg-white rounded border border-gray-200 p-4">
                        <div className="font-semibold text-gray-900 mb-3">
                          Metrics
                        </div>
                        {result.metrics.recorded && (
                          <div className="text-sm text-gray-600 mb-2">
                            <strong>Recorded:</strong>
                            <ul className="ml-5 mt-2 space-y-1">
                              {result.metrics.recorded.map((m) => (
                                <li key={m}>• {m}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}

                    {result.logs && (
                      <div className="bg-white rounded border border-gray-200 p-4">
                        <div className="font-semibold text-gray-900 mb-3">
                          Logs
                        </div>
                        {result.logs.emitted && (
                          <div className="text-sm text-gray-600 mb-2">
                            <strong>Emitted:</strong>
                            <ul className="ml-5 mt-2 space-y-1">
                              {result.logs.emitted.map((m) => (
                                <li key={m}>• {m}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
