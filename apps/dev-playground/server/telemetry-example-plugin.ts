/**
 * Telemetry Example Plugin
 *
 * Demonstrates the THREE LAYERS of observability in AppKit:
 *
 * LAYER 1: Magic API (99% of cases) - Automatic observability
 * - logger.debug()          - Terminal only (DEBUG=appkit:*)
 * - logger.trace()          - Terminal + OTEL + WideEvent (NEW!)
 * - logger.info()           - Terminal + WideEvent + Span + OTEL
 * - logger.warn()           - Terminal + WideEvent + Span + OTEL
 * - logger.error()          - Terminal + WideEvent + Span + OTEL + Exception
 * - logger.recordContext()  - WideEvent + Span attributes only (NEW!)
 *
 * LAYER 2: Opinionated API (when you need control)
 * - logger.span()      - Create auto-managed traced spans
 * - logger.counter()   - Create scoped counter metrics
 * - logger.histogram() - Create scoped histogram metrics
 * - logger.child()     - Create child logger with nested scope
 * - logger.getEvent()  - Access WideEvent for advanced use
 *
 * LAYER 3: Escape Hatch (full OTEL power)
 * - otel.getTracer()   - Raw OTEL tracer (see registerAdvancedOtelRoutes)
 * - otel.getMeter()    - Raw OTEL meter (gauges, observables)
 * - otel.getLogger()   - Raw OTEL logger (rarely needed)
 *
 * Routes:
 * - POST /api/telemetry-examples/combined - Shows all three layers
 * - POST /api/telemetry-examples/advanced-otel - Shows escape hatch usage
 */

import {
  type BasePluginConfig,
  CacheManager,
  type Counter,
  type Histogram,
  otel,
  Plugin,
  type Span,
  toPlugin,
} from "@databricks/appkit";
import type { Request, Response, Router } from "express";

class TelemetryExamples extends Plugin {
  public name = "telemetry-examples" as const;
  public envVars: string[] = [];

  private requestCounter: Counter;
  private durationHistogram: Histogram;

  constructor(config: BasePluginConfig) {
    super(config);
    this.cache = CacheManager.getInstanceSync();

    // Use the opinionated logger API for metrics
    this.requestCounter = this.logger.counter("requests.total", {
      description: "Total number of requests",
    });
    this.durationHistogram = this.logger.histogram("request.duration", {
      description: "Request duration in ms",
      unit: "ms",
    });
  }

  injectRoutes(router: Router): void {
    this.registerTelemetryExampleRoutes(router as any);
    this.registerAdvancedOtelRoutes(router as any);
  }

  private registerTelemetryExampleRoutes(router: Router) {
    this.route(router, {
      name: "combined",
      method: "post",
      path: "/combined",
      handler: async (req: Request, res: Response) => {
        const startTime = Date.now();

        return this.logger.span("combined-example", async (span: Span) => {
          span.setAttribute("example.type", "combined");
          span.setAttribute("example.version", "v2");
          try {
            const userId =
              req.body?.userId || req.query.userId || "demo-user-123";

            this.logger.info("Processing telemetry example request", {
              "user.id": userId,
              "request.type": "combined-example",
            });

            const result = await this.complexOperation(userId);

            const duration = Date.now() - startTime;
            this.requestCounter.add(1, { status: "success" });
            this.durationHistogram.record(duration);

            this.logger.info("Request completed successfully", {
              "user.id": userId,
              "duration.ms": duration,
              "result.fields": Object.keys(result as object).length,
            });

            res.json({
              success: true,
              result,
              duration_ms: duration,
              tracing: {
                hint: "Open Grafana at http://localhost:3000",
                services: [
                  "app-template (main service)",
                  "user-operations (complex operation)",
                  "auth-validation (user validation)",
                  "data-access (database operations - with cache!)",
                  "auth-service (permissions)",
                  "external-api (external HTTP calls)",
                  "data-processing (transformation)",
                ],
                expectedSpans: [
                  "HTTP POST (SDK auto-instrumentation)",
                  "combined-example (custom tracer: custom-telemetry-example)",
                  "  └─ complex-operation (custom tracer: user-operations)",
                  "     ├─ validate-user (100ms, custom tracer: auth-validation)",
                  "     ├─ fetch-user-data (200ms first call / cached on repeat, custom tracer: data-access) [parallel]",
                  "     │  └─ cache.hit attribute set by SDK (false on first call, true on repeat)",
                  "     ├─ fetch-external-resource (custom tracer: external-api) [parallel]",
                  "     │  └─ HTTP GET https://example.com (SDK auto-instrumentation)",
                  "     ├─ fetch-permissions (150ms, custom tracer: auth-service) [parallel]",
                  "     └─ transform-data (80ms, custom tracer: data-processing)",
                ],
              },
              metrics: {
                recorded: ["app.requests.total", "app.request.duration"],
              },
              logs: {
                emitted: [
                  "Starting complex operation workflow (via logger.trace)",
                  "Data fetching completed successfully",
                  "Data transformation completed",
                  "Permissions retrieved",
                  "External API call completed",
                ],
              },
              features: {
                "NEW: logger.trace()":
                  "Verbose debug logs sent to OTEL + WideEvent (not just terminal)",
                "NEW: logger.recordContext()":
                  "Record metadata without creating log entries",
                "NEW: logger.error({ recordOnSpan: false })":
                  "Log errors without failing the span (for expected errors)",
                "logger.span()":
                  "Auto-managed spans (no need for span.end(), span.setStatus())",
                "logger.info/warn/error()":
                  "Automatic flow to Terminal + WideEvent + Span + OTEL",
              },
            });
          } catch (error) {
            this.requestCounter.add(1, { status: "error" });

            this.logger.error("Request failed", error as Error, {
              "error.type": error instanceof Error ? error.name : "Unknown",
              "error.stack": error instanceof Error ? error.stack : undefined,
              "request.path": req.path,
            });

            res.status(500).json({
              error: true,
              message: error instanceof Error ? error.message : "Unknown error",
            });
          }
        });
      },
    });
  }

  private async complexOperation(userId: string) {
    return this.logger.span("complex-operation", async (parentSpan: Span) => {
      parentSpan.setAttribute("user.id", userId);
      parentSpan.setAttribute("operation.type", "user-data-flow");

      // EXAMPLE: logger.trace() - verbose debugging that goes to OTEL + WideEvent
      this.logger.trace("Starting complex operation workflow", {
        "user.id": userId,
        "workflow.step": "start",
        "workflow.timestamp": new Date().toISOString(),
      });

      // EXAMPLE: logger.recordContext() - metadata without log entry
      this.logger.recordContext({
        "operation.id": crypto.randomUUID(),
        "operation.type": "user-data-flow",
        "user.id": userId,
      });

      await this.validateUser();

      const [userData, externalData, permissionsData] = await Promise.all([
        this.fetchUserData(userId),
        this.fetchExternalResource(),
        this.fetchPermissions(),
      ]);

      this.logger.info("Data fetching completed successfully", {
        "user.id": userId,
        "data.sources": 3,
        "workflow.step": "data-fetched",
      });

      await this.transformData();

      return {
        ...userData,
        external: externalData,
        permissions: permissionsData,
      };
    });
  }

  private async validateUser() {
    return this.logger.span("validate-user", async (span: Span) => {
      span.setAttribute("validation.type", "user");
      span.setAttribute("validation.method", "token");

      this.logger.debug("Validating user credentials", {
        "validation.method": "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      this.logger.info("User validation successful", {
        "validation.duration_ms": 100,
      });
    });
  }

  private async fetchUserData(userId: string) {
    return this.logger.span("fetch-user-data", async (span: Span) => {
      span.setAttribute("data.source", "database");
      span.setAttribute("db.system", "databricks");
      span.setAttribute("db.operation", "SELECT");
      this.logger.debug("Fetching user data from database", {
        "user.id": userId,
        "cache.enabled": true,
        attributes: {
          "user.id": userId,
          "cache.enabled": true,
        },
      });

      const result = await this.cache.getOrExecute(
        ["user-data", userId],
        async () => {
          this.logger.warn(
            "Cache miss - fetching from database (slow operation)",
            {
              "user.id": userId,
              "operation.expected_duration_ms": 2000,
            },
          );

          await new Promise((resolve) => setTimeout(resolve, 2000));
          return {
            userId,
            data: "sample user data",
            preferences: { theme: "dark", language: "en" },
            lastLogin: new Date().toISOString(),
          };
        },
        "",
        { ttl: 60 }, // 60 seconds TTL
      );

      span.setAttribute("data.size_bytes", JSON.stringify(result).length);
      this.logger.info("User data retrieved successfully", {
        "user.id": userId,
        "data.size_bytes": JSON.stringify(result).length,
      });

      return result;
    });
  }

  private async fetchExternalResource() {
    return this.logger.span("fetch-external-resource", async (span: Span) => {
      span.setAttribute("http.target", "example.com");
      span.setAttribute("external.api.purpose", "demo");

      try {
        this.logger.debug("Calling external API", {
          "http.url": "https://example.com",
          "http.method": "GET",
        });

        const response = await fetch("https://example.com");
        const text = await response.text();

        span.setAttribute("http.status_code", response.status);
        span.setAttribute("http.response.size_bytes", text.length);
        span.addEvent("external_fetch_completed", {
          "response.status": response.status,
        });

        this.logger.info("External API call completed", {
          "http.url": "https://example.com",
          "http.status_code": response.status,
          "http.response.size_bytes": text.length,
        });

        return { status: response.status, size: text.length };
      } catch (error) {
        // EXAMPLE: logger.error() with recordOnSpan: false
        // This is an expected/graceful error - we return a fallback value
        // So we don't want to mark the span as failed
        this.logger.error(
          "External API call failed (graceful fallback)",
          error as Error,
          {
            "http.url": "https://example.com",
            "error.message":
              error instanceof Error ? error.message : "Unknown error",
            "fallback.returned": true,
          },
          { recordOnSpan: false }, // Don't fail the parent span
        );

        return { status: 0, size: 0, error: "fetch failed" };
      }
    });
  }

  private async fetchPermissions() {
    return this.logger.span("fetch-permissions", async (span: Span) => {
      span.setAttribute("permissions.scope", "user");
      span.setAttribute("permissions.type", "rbac");

      this.logger.debug("Fetching user permissions", {
        "permissions.type": "rbac",
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const permissions = {
        canRead: true,
        canWrite: false,
        canDelete: false,
      };

      this.logger.info("Permissions retrieved", {
        "permissions.canRead": permissions.canRead,
        "permissions.canWrite": permissions.canWrite,
        "permissions.canDelete": permissions.canDelete,
      });

      return permissions;
    });
  }

  private async transformData() {
    return this.logger.span("transform-data", async (span: Span) => {
      span.setAttribute("transform.type", "enrichment");
      span.setAttribute("transform.steps", "normalize,enrich,validate");
      span.setAttribute("external.data.included", true);

      this.logger.debug("Starting data transformation pipeline", {
        "transform.steps": ["normalize", "enrich", "validate"],
      });

      await new Promise((resolve) => setTimeout(resolve, 80));

      span.addEvent("transformation_completed", {
        "output.fields": 5,
        "processing.success": true,
      });

      this.logger.info("Data transformation completed", {
        "transform.duration_ms": 80,
        "output.fields": 5,
      });
    });
  }

  /**
   * ADVANCED: Direct OTEL escape hatch for power users
   *
   * Use this when you need:
   * - Custom tracer names not scoped to the plugin
   * - Raw OTEL Meter for gauges, observable instruments
   * - Direct access to OTEL APIs for special use cases
   *
   * For most use cases, prefer the opinionated logger API:
   * - this.logger.span() instead of otel.getTracer()
   * - this.logger.counter() instead of otel.getMeter().createCounter()
   */
  private registerAdvancedOtelRoutes(router: Router) {
    this.route(router, {
      name: "advanced-otel",
      method: "post",
      path: "/advanced-otel",
      handler: async (_req: Request, res: Response) => {
        // ADVANCED: Get raw OTEL tracer for custom instrumentation
        const customTracer = otel.getTracer("custom-advanced-tracer");

        // ADVANCED: Get raw OTEL meter for gauges and observable instruments
        const customMeter = otel.getMeter("custom-advanced-meter");

        // Create an observable gauge (not available via logger API)
        const activeConnections = customMeter.createObservableGauge(
          "app.connections.active",
          {
            description: "Number of active connections",
            unit: "connections",
          },
        );

        // Observable instruments need a callback
        activeConnections.addCallback((result: any) => {
          // In real code, this would read from your connection pool
          result.observe(Math.floor(Math.random() * 100));
        });

        // Create a span using raw tracer
        await customTracer.startActiveSpan(
          "advanced-custom-operation",
          async (span: Span) => {
            span.setAttribute("advanced.example", true);
            span.setAttribute("custom.tracer.name", "custom-advanced-tracer");

            // You can still use the opinionated logger inside raw spans
            this.logger.info("Inside raw OTEL span", {
              "span.kind": "custom",
            });

            await new Promise((resolve) => setTimeout(resolve, 50));

            span.end();
          },
        );

        res.json({
          success: true,
          message: "Advanced OTEL example completed",
          layers: {
            "LAYER 1: Magic API (99% of use cases)": {
              description:
                "Automatic observability - just log and it flows everywhere",
              methods: [
                "logger.debug() - Terminal only (DEBUG=appkit:*)",
                "logger.trace() - Terminal + OTEL + WideEvent [NEW!]",
                "logger.info() - Terminal + WideEvent + Span + OTEL",
                "logger.warn() - Terminal + WideEvent + Span + OTEL",
                "logger.error() - Terminal + WideEvent + Span + OTEL + Exception",
                "logger.recordContext() - WideEvent + Span attributes only [NEW!]",
              ],
            },
            "LAYER 2: Opinionated API (when you need control)": {
              description: "Custom spans, metrics, and scoping",
              methods: [
                "logger.span() - Auto-managed traced spans",
                "logger.counter() - Scoped counter metrics",
                "logger.histogram() - Scoped histogram metrics",
                "logger.child() - Nested logger scopes",
                "logger.getEvent() - Access WideEvent for advanced use",
              ],
            },
            "LAYER 3: Escape Hatch (full OTEL power)": {
              description: "Use when you need features not in Layer 1 or 2",
              methods: [
                "otel.getTracer() - Custom tracer names, full span control",
                "otel.getMeter() - Gauges, observable instruments",
                "otel.getLogger() - Raw OTEL logger (rarely needed)",
              ],
              whenToUse: [
                "Observable gauges (like active connection count)",
                "Custom tracer names not scoped to plugin",
                "SpanKind customization (CLIENT, SERVER, etc.)",
                "Manual span linking across services",
              ],
            },
          },
          recommendation:
            "Start with LAYER 1 (Magic API). Use LAYER 2 for custom spans. " +
            "Only use LAYER 3 (Escape Hatch) when you need features not available in layers 1-2.",
          newFeatures: {
            "logger.trace()": {
              description:
                "Verbose debugging that goes to OTEL (unlike debug which is terminal-only)",
              useCases: [
                "Production debugging with detailed context",
                "Tracing request flow through multiple services",
                "Recording intermediate state for troubleshooting",
              ],
            },
            "logger.recordContext()": {
              description:
                "Record metadata to WideEvent and Span without creating log entries",
              useCases: [
                "Enriching request context with IDs (operation ID, correlation ID)",
                "Recording computed values (cache key, query hash)",
                "Adding metadata that doesn't need to appear in logs",
              ],
            },
            "logger.error({ recordOnSpan: false })": {
              description: "Log errors without marking the span as failed",
              useCases: [
                "Expected errors with graceful fallbacks (like failed external API)",
                "Validation errors that are handled",
                "Cache misses or other recoverable errors",
              ],
            },
          },
        });
      },
    });
  }
}

export const telemetryExamples = toPlugin<
  typeof TelemetryExamples,
  BasePluginConfig,
  "telemetry-examples"
>(TelemetryExamples, "telemetry-examples");
