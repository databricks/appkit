/**
 * Minimal plugin to register telemetry example routes
 */

import {
  Plugin,
  toPlugin,
  type BasePluginConfig,
  CacheManager,
  SpanStatusCode,
  type Span,
  type Counter,
  type Histogram,
  SeverityNumber,
} from "@databricks/appkit";
import type { Request, Response, Router } from "express";

class TelemetryExamples extends Plugin {
  public name = "telemetry-examples" as const;
  public envVars: string[] = [];

  private requestCounter: Counter;
  private durationHistogram: Histogram;

  constructor(config: BasePluginConfig) {
    super(config);
    this.cache = new CacheManager({ enabled: true, ttl: 60 }, this.telemetry);

    const meter = this.telemetry.getMeter({ name: "custom-telemetry-example" });
    this.requestCounter = meter.createCounter("app.requests.total", {
      description: "Total number of requests",
    });
    this.durationHistogram = meter.createHistogram("app.request.duration", {
      description: "Request duration in ms",
      unit: "ms",
    });
  }

  injectRoutes(router: Router): void {
    this.registerTelemetryExampleRoutes(router as any);
  }

  private registerTelemetryExampleRoutes(router: Router) {
    this.route(router, {
      name: "combined",
      method: "post",
      path: "/combined",
      handler: async (req: Request, res: Response) => {
        const startTime = Date.now();

        return this.telemetry.startActiveSpan(
          "combined-example",
          {
            attributes: {
              "example.type": "combined",
              "example.version": "v2",
            },
          },
          async (span: Span) => {
            try {
              const userId =
                req.body?.userId || req.query.userId || "demo-user-123";

              this.telemetry.emit({
                severityNumber: SeverityNumber.INFO,
                severityText: "INFO",
                body: "Processing telemetry example request",
                attributes: {
                  "user.id": userId,
                  "request.type": "combined-example",
                },
              });

              const result = await this.complexOperation(userId);

              const duration = Date.now() - startTime;
              this.requestCounter.add(1, { status: "success" });
              this.durationHistogram.record(duration);

              this.telemetry.emit({
                severityNumber: SeverityNumber.INFO,
                severityText: "INFO",
                body: "Request completed successfully",
                attributes: {
                  "user.id": userId,
                  "duration.ms": duration,
                  "result.fields": Object.keys(result).length,
                },
              });

              span.setStatus({ code: SpanStatusCode.OK });

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
                    "Starting complex operation workflow",
                    "Data fetching completed successfully",
                    "Data transformation completed",
                    "Permissions retrieved",
                    "External API call completed",
                  ],
                },
              });
            } catch (error) {
              span.recordException(error as Error);
              span.setStatus({ code: SpanStatusCode.ERROR });
              this.requestCounter.add(1, { status: "error" });

              this.telemetry.emit({
                severityNumber: SeverityNumber.ERROR,
                severityText: "ERROR",
                body: error instanceof Error ? error.message : "Unknown error",
                attributes: {
                  "error.type": error instanceof Error ? error.name : "Unknown",
                  "error.stack":
                    error instanceof Error ? error.stack : undefined,
                  "request.path": req.path,
                },
              });

              res.status(500).json({
                error: true,
                message:
                  error instanceof Error ? error.message : "Unknown error",
              });
            } finally {
              span.end();
            }
          },
          { name: "custom-telemetry-example" },
        );
      },
    });
  }

  private async complexOperation(userId: string) {
    return this.telemetry.startActiveSpan(
      "complex-operation",
      {
        attributes: {
          "user.id": userId,
          "operation.type": "user-data-flow",
        },
      },
      async (parentSpan: Span) => {
        try {
          this.telemetry.emit({
            severityNumber: SeverityNumber.DEBUG,
            severityText: "DEBUG",
            body: "Starting complex operation workflow",
            attributes: {
              "user.id": userId,
              "workflow.step": "start",
            },
          });

          await this.validateUser();

          const [userData, externalData, permissionsData] = await Promise.all([
            this.fetchUserData(userId),
            this.fetchExternalResource(),
            this.fetchPermissions(),
          ]);

          this.telemetry.emit({
            severityNumber: SeverityNumber.INFO,
            severityText: "INFO",
            body: "Data fetching completed successfully",
            attributes: {
              "user.id": userId,
              "data.sources": 3,
              "workflow.step": "data-fetched",
            },
          });

          await this.transformData();

          parentSpan.setStatus({ code: SpanStatusCode.OK });

          return {
            ...userData,
            external: externalData,
            permissions: permissionsData,
          };
        } catch (error) {
          parentSpan.recordException(error as Error);
          parentSpan.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          parentSpan.end();
        }
      },
      { name: "user-operations" },
    );
  }

  private async validateUser() {
    return this.telemetry.startActiveSpan(
      "validate-user",
      {
        attributes: {
          "validation.type": "user",
          "validation.method": "token",
        },
      },
      async (span: Span) => {
        try {
          this.telemetry.emit({
            severityNumber: SeverityNumber.DEBUG,
            severityText: "DEBUG",
            body: "Validating user credentials",
            attributes: {
              "validation.method": "token",
            },
          });

          await new Promise((resolve) => setTimeout(resolve, 100));

          this.telemetry.emit({
            severityNumber: SeverityNumber.INFO,
            severityText: "INFO",
            body: "User validation successful",
            attributes: {
              "validation.duration_ms": 100,
            },
          });

          span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
      { name: "auth-validation" },
    );
  }

  private async fetchUserData(userId: string) {
    return this.telemetry.startActiveSpan(
      "fetch-user-data",
      {
        attributes: {
          "data.source": "database",
          "db.system": "databricks",
          "db.operation": "SELECT",
        },
      },
      async (span: Span) => {
        try {
          this.telemetry.emit({
            severityNumber: SeverityNumber.DEBUG,
            severityText: "DEBUG",
            body: "Fetching user data from database",
            attributes: {
              "user.id": userId,
              "cache.enabled": true,
            },
          });

          const result = await this.cache.getOrExecute(
            ["user-data", userId],
            async () => {
              this.telemetry.emit({
                severityNumber: SeverityNumber.WARN,
                severityText: "WARN",
                body: "Cache miss - fetching from database (slow operation)",
                attributes: {
                  "user.id": userId,
                  "operation.expected_duration_ms": 2000,
                },
              });

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
          span.setStatus({ code: SpanStatusCode.OK });

          this.telemetry.emit({
            severityNumber: SeverityNumber.INFO,
            severityText: "INFO",
            body: "User data retrieved successfully",
            attributes: {
              "user.id": userId,
              "data.size_bytes": JSON.stringify(result).length,
            },
          });

          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
      { name: "data-access" },
    );
  }

  private async fetchExternalResource() {
    return this.telemetry.startActiveSpan(
      "fetch-external-resource",
      {
        attributes: {
          "http.target": "example.com",
          "external.api.purpose": "demo",
        },
      },
      async (span: Span) => {
        try {
          this.telemetry.emit({
            severityNumber: SeverityNumber.DEBUG,
            severityText: "DEBUG",
            body: "Calling external API",
            attributes: {
              "http.url": "https://example.com",
              "http.method": "GET",
            },
          });

          const response = await fetch("https://example.com");
          const text = await response.text();

          span.setAttribute("http.status_code", response.status);
          span.setAttribute("http.response.size_bytes", text.length);
          span.addEvent("external_fetch_completed", {
            "response.status": response.status,
          });
          span.setStatus({ code: SpanStatusCode.OK });

          this.telemetry.emit({
            severityNumber: SeverityNumber.INFO,
            severityText: "INFO",
            body: "External API call completed",
            attributes: {
              "http.url": "https://example.com",
              "http.status_code": response.status,
              "http.response.size_bytes": text.length,
            },
          });

          return { status: response.status, size: text.length };
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });

          this.telemetry.emit({
            severityNumber: SeverityNumber.ERROR,
            severityText: "ERROR",
            body: "External API call failed",
            attributes: {
              "http.url": "https://example.com",
              "error.message":
                error instanceof Error ? error.message : "Unknown error",
            },
          });

          return { status: 0, size: 0, error: "fetch failed" };
        } finally {
          span.end();
        }
      },
      { name: "external-api" },
    );
  }

  private async fetchPermissions() {
    return this.telemetry.startActiveSpan(
      "fetch-permissions",
      {
        attributes: {
          "permissions.scope": "user",
          "permissions.type": "rbac",
        },
      },
      async (span: Span) => {
        try {
          this.telemetry.emit({
            severityNumber: SeverityNumber.DEBUG,
            severityText: "DEBUG",
            body: "Fetching user permissions",
            attributes: {
              "permissions.type": "rbac",
            },
          });

          await new Promise((resolve) => setTimeout(resolve, 150));

          const permissions = {
            canRead: true,
            canWrite: false,
            canDelete: false,
          };

          this.telemetry.emit({
            severityNumber: SeverityNumber.INFO,
            severityText: "INFO",
            body: "Permissions retrieved",
            attributes: {
              "permissions.canRead": permissions.canRead,
              "permissions.canWrite": permissions.canWrite,
              "permissions.canDelete": permissions.canDelete,
            },
          });

          span.setStatus({ code: SpanStatusCode.OK });
          return permissions;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
      { name: "auth-service" },
    );
  }

  private async transformData() {
    return this.telemetry.startActiveSpan(
      "transform-data",
      {
        attributes: {
          "transform.type": "enrichment",
          "transform.steps": "normalize,enrich,validate",
          "external.data.included": true,
        },
      },
      async (span: Span) => {
        try {
          this.telemetry.emit({
            severityNumber: SeverityNumber.DEBUG,
            severityText: "DEBUG",
            body: "Starting data transformation pipeline",
            attributes: {
              "transform.steps": ["normalize", "enrich", "validate"],
            },
          });

          await new Promise((resolve) => setTimeout(resolve, 80));

          span.addEvent("transformation_completed", {
            "output.fields": 5,
            "processing.success": true,
          });

          this.telemetry.emit({
            severityNumber: SeverityNumber.INFO,
            severityText: "INFO",
            body: "Data transformation completed",
            attributes: {
              "transform.duration_ms": 80,
              "output.fields": 5,
            },
          });

          span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
      { name: "data-processing" },
    );
  }
}

export const telemetryExamples = toPlugin<
  typeof TelemetryExamples,
  BasePluginConfig,
  "telemetry-examples"
>(TelemetryExamples, "telemetry-examples");
