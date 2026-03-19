import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@databricks/appkit-ui/react";
import { createFileRoute, retainSearchParams } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Header } from "@/components/layout/header";

export const Route = createFileRoute("/sidecar")({
  component: SidecarRoute,
  search: {
    middlewares: [retainSearchParams(true)],
  },
});

// ── Types ────────────────────────────────────────────────────────────
interface RequestEntry {
  id: number;
  method: string;
  path: string;
  status: "pending" | "success" | "error";
  statusCode?: number;
  body?: string;
  duration?: number;
  error?: string;
  timestamp: Date;
}

// ── Helpers ──────────────────────────────────────────────────────────
let requestId = 0;

function statusBadgeVariant(
  status: RequestEntry["status"],
): "default" | "destructive" | "secondary" {
  if (status === "success") return "default";
  if (status === "error") return "destructive";
  return "secondary";
}

// ── Sidecar Panel (shared by both tabs) ──────────────────────────────
function SidecarPanel({
  mode,
  basePath,
  endpoints,
}: {
  mode: "http" | "stdio";
  basePath: string;
  endpoints: {
    label: string;
    method: string;
    path: string;
    hasBody?: boolean;
    defaultBody?: string;
  }[];
}) {
  const [history, setHistory] = useState<RequestEntry[]>([]);
  const [customBody, setCustomBody] = useState("{}");

  const sendRequest = useCallback(
    async (method: string, path: string, body?: string) => {
      const id = ++requestId;
      const entry: RequestEntry = {
        id,
        method,
        path,
        status: "pending",
        timestamp: new Date(),
      };
      setHistory((prev) => [entry, ...prev]);

      const start = performance.now();
      try {
        const opts: RequestInit = { method };
        if (body) {
          opts.headers = { "Content-Type": "application/json" };
          opts.body = body;
        }
        const res = await fetch(`${basePath}${path}`, opts);
        const duration = Math.round(performance.now() - start);
        const data = await res.json();

        setHistory((prev) =>
          prev.map((e) =>
            e.id === id
              ? {
                  ...e,
                  status: res.ok ? "success" : "error",
                  statusCode: res.status,
                  body: JSON.stringify(data, null, 2),
                  duration,
                }
              : e,
          ),
        );
      } catch (err) {
        const duration = Math.round(performance.now() - start);
        setHistory((prev) =>
          prev.map((e) =>
            e.id === id
              ? {
                  ...e,
                  status: "error",
                  error: err instanceof Error ? err.message : "Unknown error",
                  duration,
                }
              : e,
          ),
        );
      }
    },
    [basePath],
  );

  return (
    <div className="space-y-6">
      {/* Info Bar */}
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Badge variant="secondary">{mode.toUpperCase()}</Badge>
        <span className="font-mono">{basePath}/*</span>
        {mode === "http" && (
          <span className="text-xs">
            Requests are proxied directly to the child HTTP server
          </span>
        )}
        {mode === "stdio" && (
          <span className="text-xs">
            Requests are translated to JSON-RPC 2.0 over stdin/stdout
          </span>
        )}
      </div>

      {/* Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Endpoints</CardTitle>
          <CardDescription>
            Send requests to the{" "}
            {mode === "http" ? "Python HTTP" : "Python stdio"} sidecar
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            {endpoints.map((ep) => (
              <Button
                key={`${ep.method}-${ep.path}`}
                variant="outline"
                onClick={() =>
                  sendRequest(
                    ep.method,
                    ep.path,
                    ep.hasBody ? customBody : undefined,
                  )
                }
              >
                <span className="font-mono text-xs mr-2 opacity-60">
                  {ep.method}
                </span>
                {ep.label}
              </Button>
            ))}
          </div>

          {endpoints.some((ep) => ep.hasBody) && (
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor={`body-${mode}`}>
                Request Body (JSON)
              </label>
              <Textarea
                id={`body-${mode}`}
                className="font-mono text-sm h-24"
                value={customBody}
                onChange={(e) => setCustomBody(e.target.value)}
                placeholder='{"key": "value"}'
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* History */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-lg">Request History</CardTitle>
            <CardDescription>
              {history.length === 0
                ? "No requests yet — try an endpoint above"
                : `${history.length} request${history.length === 1 ? "" : "s"}`}
            </CardDescription>
          </div>
          {history.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setHistory([])}>
              Clear
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <div className="space-y-3 max-h-[500px] overflow-y-auto">
            {history.map((entry) => (
              <div
                key={entry.id}
                className="rounded-lg border bg-secondary/30 p-4 space-y-2"
              >
                {/* Request header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant={statusBadgeVariant(entry.status)}>
                      {entry.status === "pending"
                        ? "..."
                        : (entry.statusCode ?? entry.status)}
                    </Badge>
                    <span className="font-mono text-sm font-medium">
                      {entry.method} {entry.path}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {entry.duration != null && <span>{entry.duration}ms</span>}
                    <span>{entry.timestamp.toLocaleTimeString()}</span>
                  </div>
                </div>

                {/* Response body or error */}
                {entry.body && (
                  <pre className="text-xs font-mono bg-gray-900 text-green-400 p-3 rounded-md overflow-x-auto whitespace-pre-wrap">
                    {entry.body}
                  </pre>
                )}
                {entry.error && (
                  <div className="text-sm text-destructive bg-destructive/10 rounded-md p-3">
                    {entry.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Page Component ───────────────────────────────────────────────────
function SidecarRoute() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-6 py-12">
        <Header
          title="Sidecar Plugin"
          description="Run polyglot child processes alongside your Node.js server. AppKit manages the lifecycle, health checks, and request routing."
          tooltip="Two communication modes: HTTP (proxy to child's HTTP server) and STDIO (JSON-RPC 2.0 over stdin/stdout)"
        />

        <Tabs defaultValue="http">
          <TabsList className="mb-6">
            <TabsTrigger value="http">HTTP Mode</TabsTrigger>
            <TabsTrigger value="stdio">STDIO Mode</TabsTrigger>
          </TabsList>

          <TabsContent value="http">
            <div className="space-y-4">
              <div className="rounded-lg border bg-card p-4 text-sm space-y-2">
                <p className="font-medium">How it works</p>
                <p className="text-muted-foreground">
                  The sidecar spawns a Python HTTP server on an auto-assigned
                  port. AppKit proxies all requests under{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    /api/sidecar-http/*
                  </code>{" "}
                  directly to the child process. Health checks poll{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    GET /health
                  </code>{" "}
                  periodically.
                </p>
              </div>
              <Separator />
              <SidecarPanel
                mode="http"
                basePath="/api/sidecar-http"
                endpoints={[
                  { label: "/hello", method: "GET", path: "/hello" },
                  { label: "/health", method: "GET", path: "/health" },
                ]}
              />
            </div>
          </TabsContent>

          <TabsContent value="stdio">
            <div className="space-y-4">
              <div className="rounded-lg border bg-card p-4 text-sm space-y-2">
                <p className="font-medium">How it works</p>
                <p className="text-muted-foreground">
                  The sidecar spawns a Python script and communicates via
                  line-delimited JSON-RPC 2.0 over stdin/stdout. AppKit
                  translates HTTP requests arriving at{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    /api/sidecar-stdio/*
                  </code>{" "}
                  into JSON-RPC messages, correlating responses by ID.
                </p>
              </div>
              <Separator />
              <SidecarPanel
                mode="stdio"
                basePath="/api/sidecar-stdio"
                endpoints={[
                  { label: "/hello", method: "GET", path: "/hello" },
                  {
                    label: "/echo",
                    method: "POST",
                    path: "/echo",
                    hasBody: true,
                    defaultBody: '{"greeting": "Hello from the browser!"}',
                  },
                ]}
              />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
