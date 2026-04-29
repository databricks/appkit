import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  Card,
} from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, Loader2 } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/internal-telemetry")({
  component: InternalTelemetryRoute,
});

const BASE = "/api/internal-telemetry-debug";

const ACTIONS = [
  {
    id: "startup",
    title: "Send APP_STARTUP",
    description:
      "Sends an AppkitLog with event_name=APP_STARTUP. Mirrors what createApp emits at boot.",
    endpoint: `${BASE}/startup`,
  },
  {
    id: "heartbeat",
    title: "Send HEARTBEAT",
    description:
      "Sends an AppkitLog with event_name=HEARTBEAT. Bypasses the periodic heartbeat timer.",
    endpoint: `${BASE}/heartbeat`,
  },
  {
    id: "record",
    title: "Record sample request metrics",
    description:
      "Adds a synthetic request to the in-memory aggregator. Run a few times before flushing.",
    endpoint: `${BASE}/request-metrics-record`,
    body: {
      method: "GET",
      endpoint: "/api/sample/:id",
      statusCode: 200,
      latencyMs: 42,
    },
  },
  {
    id: "flush",
    title: "Flush REQUEST_METRICS",
    description:
      "Drains the request metrics aggregator and sends one AppkitLog per endpoint.",
    endpoint: `${BASE}/request-metrics-flush`,
  },
] as const;

type DispatchRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

type DispatchResponse = {
  status: number;
  statusText: string;
  body: string;
};

type ActionResult = {
  ok?: boolean;
  error?: string;
  action?: string;
  message?: string;
  request?: DispatchRequest;
  response?: DispatchResponse;
  curl?: string;
  recorded?: unknown;
};

function InternalTelemetryRoute() {
  const [loading, setLoading] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ActionResult>>({});

  const run = async (
    id: string,
    endpoint: string,
    body?: Record<string, unknown>,
  ) => {
    setLoading(id);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await response.json()) as ActionResult;
      setResults((prev) => ({ ...prev, [id]: data }));
    } catch (error) {
      setResults((prev) => ({
        ...prev,
        [id]: { error: error instanceof Error ? error.message : String(error) },
      }));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-6 py-12">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Internal Telemetry</h1>
          <p className="text-base text-gray-500">
            Manually trigger AppKit's internal telemetry events to verify the
            pipeline end-to-end. Each action shows the exact request that was
            POSTed to the workspace's <code>/telemetry</code> endpoint, the
            response, and a <code>curl</code> command you can run locally.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4">
          {ACTIONS.map((action) => {
            const result = results[action.id];
            const isLoading = loading === action.id;
            return (
              <Card key={action.id} className="p-6 min-w-0 overflow-hidden">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <h2 className="text-xl font-semibold mb-1">
                      {action.title}
                    </h2>
                    <p className="text-sm text-gray-600">
                      {action.description}
                    </p>
                  </div>
                  <Button
                    onClick={() =>
                      run(
                        action.id,
                        action.endpoint,
                        "body" in action ? action.body : undefined,
                      )
                    }
                    disabled={isLoading}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Sending...
                      </>
                    ) : (
                      "Send"
                    )}
                  </Button>
                </div>

                {result && <ResultDetails result={result} />}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ResultDetails({ result }: { result: ActionResult }) {
  const status = statusBadge(result);
  const items: Array<{
    value: string;
    title: string;
    content: React.ReactNode;
  }> = [];

  if (result.recorded !== undefined) {
    items.push({
      value: "recorded",
      title: "Recorded",
      content: <CodeBlock>{stringify(result.recorded)}</CodeBlock>,
    });
  }
  if (result.request) {
    items.push({
      value: "request",
      title: "Request",
      content: (
        <div className="space-y-2 min-w-0">
          <div className="text-xs font-mono text-muted-foreground break-all">
            {result.request.method} {result.request.url}
          </div>
          <Subsection title="Headers">
            <CodeBlock>{stringify(result.request.headers)}</CodeBlock>
          </Subsection>
          <Subsection title="Body">
            <CodeBlock>{prettyJson(result.request.body)}</CodeBlock>
          </Subsection>
        </div>
      ),
    });
  }
  if (result.response) {
    items.push({
      value: "response",
      title: "Response",
      content: (
        <div className="space-y-2 min-w-0">
          <div className="text-xs font-mono text-muted-foreground break-all">
            HTTP {result.response.status} {result.response.statusText}
          </div>
          <Subsection title="Body">
            <CodeBlock>{result.response.body || "(empty)"}</CodeBlock>
          </Subsection>
        </div>
      ),
    });
  }

  return (
    <div className="mt-4 space-y-3 min-w-0">
      <div
        className={`px-3 py-2 rounded text-sm font-medium border ${status.className}`}
      >
        {status.label}
      </div>
      {result.message && (
        <div className="text-sm text-muted-foreground">{result.message}</div>
      )}
      {result.error && (
        <pre className="p-3 rounded text-xs overflow-x-auto bg-red-50 text-red-800 border border-red-200">
          {result.error}
        </pre>
      )}
      {items.length > 0 && (
        <Accordion
          type="multiple"
          defaultValue={["request", "response"]}
          className="border rounded divide-y"
        >
          {items.map((item) => (
            <AccordionItem
              key={item.value}
              value={item.value}
              className="border-b-0 px-3"
            >
              <AccordionTrigger className="py-2 text-sm">
                {item.title}
              </AccordionTrigger>
              <AccordionContent>{item.content}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
      {result.curl && <CurlBlock curl={result.curl} />}
    </div>
  );
}

function statusBadge(result: ActionResult): {
  label: string;
  className: string;
} {
  if (result.error) {
    return {
      label: `Error: ${result.error}`,
      className: "bg-red-50 text-red-800 border-red-200",
    };
  }
  if (result.response) {
    const code = result.response.status;
    const ok = code >= 200 && code < 300;
    return {
      label: `${ok ? "Success" : "Failed"} — HTTP ${code} ${result.response.statusText}`,
      className: ok
        ? "bg-green-50 text-green-800 border-green-200"
        : "bg-yellow-50 text-yellow-900 border-yellow-200",
    };
  }
  if (result.ok) {
    return {
      label: result.message ?? "Done",
      className: "bg-green-50 text-green-800 border-green-200",
    };
  }
  return {
    label: "Done",
    className: "bg-gray-50 text-gray-800 border-gray-200",
  };
}

function Subsection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
        {title}
      </div>
      {children}
    </div>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="text-xs bg-gray-900 text-gray-100 p-2 rounded overflow-auto max-h-64 whitespace-pre-wrap break-all">
      {children}
    </pre>
  );
}

function CurlBlock({ curl }: { curl: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(curl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="border border-gray-200 rounded">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50">
        <span className="text-sm font-semibold">Reproduce with curl</span>
        <Button variant="ghost" size="sm" onClick={copy}>
          {copied ? (
            <>
              <Check className="mr-1 h-3 w-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="mr-1 h-3 w-3" /> Copy
            </>
          )}
        </Button>
      </div>
      <pre className="text-xs bg-gray-900 text-gray-100 p-3 rounded-b overflow-auto max-h-64 whitespace-pre-wrap break-all">
        {curl}
      </pre>
    </div>
  );
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
