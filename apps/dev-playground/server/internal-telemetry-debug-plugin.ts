import {
  Plugin,
  type PluginManifest,
  TelemetryReporter,
  type TelemetrySendRequest,
  type TelemetrySendResult,
  toPlugin,
} from "@databricks/appkit";
import type { Request, Response, Router } from "express";

type ReporterAction = "sendStartup" | "sendHeartbeat" | "flushRequestMetrics";

class InternalTelemetryDebug extends Plugin {
  static manifest = {
    name: "internal-telemetry-debug",
    displayName: "Internal Telemetry Debug Plugin",
    description: "Manually trigger internal telemetry events for testing",
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<"internal-telemetry-debug">;

  injectRoutes(router: Router): void {
    router.post("/startup", this.handle("sendStartup"));
    router.post("/heartbeat", this.handle("sendHeartbeat"));
    router.post("/request-metrics-flush", this.handle("flushRequestMetrics"));
    router.post("/request-metrics-record", (req, res) => {
      const reporter = TelemetryReporter.getInstance();
      if (!reporter) {
        res.status(503).json({ error: "Telemetry reporter not initialized" });
        return;
      }
      const {
        method = "GET",
        endpoint = "/api/internal-telemetry-debug/sample",
        statusCode = 200,
        latencyMs = 12,
      } = (req.body ?? {}) as {
        method?: string;
        endpoint?: string;
        statusCode?: number;
        latencyMs?: number;
      };
      reporter.recordRequest(method, endpoint, statusCode, latencyMs);
      res.json({
        ok: true,
        recorded: { method, endpoint, statusCode, latencyMs },
      });
    });
  }

  private handle(action: ReporterAction) {
    return async (_req: Request, res: Response) => {
      const reporter = TelemetryReporter.getInstance();
      if (!reporter) {
        res.status(503).json({ error: "Telemetry reporter not initialized" });
        return;
      }
      try {
        const result = await reporter[action]();
        res.json(formatSuccess(action, result));
      } catch (error) {
        res.status(500).json({
          ok: false,
          action,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }
}

function formatSuccess(
  action: ReporterAction,
  result: TelemetrySendResult | null,
) {
  if (!result) {
    return {
      ok: true,
      action,
      message:
        "Nothing to send (request metrics buffer empty — record some first).",
    };
  }
  return {
    ok: result.response.status >= 200 && result.response.status < 300,
    action,
    request: result.request,
    response: result.response,
    curl: toCurl(result.request),
  };
}

function toCurl(req: TelemetrySendRequest): string {
  const quote = (s: string) => s.replace(/'/g, "'\\''");
  const lines = [`curl -X POST '${quote(req.url)}'`];
  for (const [name, value] of Object.entries(req.headers)) {
    lines.push(`  -H '${quote(name)}: ${quote(value)}'`);
  }
  lines.push(`  --data '${quote(req.body)}'`);
  return lines.join(" \\\n");
}

export const internalTelemetryDebug = toPlugin(InternalTelemetryDebug);
