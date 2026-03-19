import http from "node:http";
import posixPath from "node:path/posix";
import type { Counter, Histogram, UpDownCounter } from "@opentelemetry/api";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { IAppRequest, IAppResponse } from "shared";
import { SidecarError } from "../../errors/sidecar";
import { createLogger } from "../../logging/logger";
import type { ITelemetry } from "../../telemetry/types";
import type { ProxyConfig, SidecarStatus } from "./types";

const logger = createLogger("sidecar:proxy");

const DEFAULTS: Required<ProxyConfig> = {
  forwardHeaders: "all",
  injectHeaders: {},
  timeout: 30_000,
  basePath: "/",
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function classifyError(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case "ECONNREFUSED":
      return "connection_refused";
    case "ECONNRESET":
      return "connection_reset";
    case "ETIMEDOUT":
      return "timeout";
    default:
      return "proxy_error";
  }
}

export class SidecarProxy {
  private readonly config: Required<ProxyConfig>;
  private readonly port: number;
  private readonly telemetry: ITelemetry;
  private readonly metrics: {
    requestCount: Counter;
    requestDuration: Histogram;
    errorCount: Counter;
    pendingGauge: UpDownCounter;
  };

  constructor(port: number, telemetry: ITelemetry, config?: ProxyConfig) {
    this.port = port;
    this.telemetry = telemetry;
    this.config = { ...DEFAULTS, ...config };

    const meter = this.telemetry.getMeter();
    this.metrics = {
      requestCount: meter.createCounter("sidecar.proxy.request.count", {
        description: "Total proxied HTTP requests to sidecar",
        unit: "1",
      }),
      requestDuration: meter.createHistogram("sidecar.proxy.request.duration", {
        description: "Round-trip time for proxied HTTP requests",
        unit: "ms",
      }),
      errorCount: meter.createCounter("sidecar.proxy.error.count", {
        description: "Total proxy errors (timeout, connection, etc.)",
        unit: "1",
      }),
      pendingGauge: meter.createUpDownCounter("sidecar.proxy.pending", {
        description: "Currently pending (in-flight) proxied requests",
        unit: "1",
      }),
    };
  }

  middleware(
    getStatus: () => SidecarStatus,
  ): (req: IAppRequest, res: IAppResponse) => void {
    return (req: IAppRequest, res: IAppResponse) => {
      const status = getStatus();
      if (status !== "healthy") {
        res.status(503).json({
          error: "Sidecar process is not ready",
          status,
        });
        return;
      }

      this.proxyRequest(req, res);
    };
  }

  private proxyRequest(req: IAppRequest, res: IAppResponse): void {
    let targetPath: string;
    try {
      targetPath = this.buildTargetPath(req.path);
    } catch {
      res.status(400).json({ error: "Invalid request path" });
      return;
    }
    const headers = this.buildHeaders(req);
    const fullPath = targetPath + this.extractQueryString(req.url);

    // Fire-and-forget — all error handling is internal to executeProxy
    void this.executeProxy(req, res, fullPath, headers);
  }

  private executeProxy(
    req: IAppRequest,
    res: IAppResponse,
    fullPath: string,
    headers: Record<string, string | string[]>,
  ): Promise<void> {
    return this.telemetry.startActiveSpan(
      "sidecar.proxy.request",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "sidecar.proxy.path": req.path,
          "sidecar.proxy.method": req.method,
          "sidecar.proxy.target_port": this.port,
        },
      },
      async (span) => {
        const startTime = Date.now();
        this.metrics.pendingGauge.add(1);

        try {
          logger.debug(
            "%s %s → localhost:%d%s",
            req.method,
            req.path,
            this.port,
            fullPath,
          );

          const statusCode = await new Promise<number>((resolve, reject) => {
            const proxyReq = http.request(
              {
                hostname: "localhost",
                port: this.port,
                method: req.method,
                path: fullPath,
                headers,
                timeout: this.config.timeout,
              },
              (proxyRes) => {
                const status = proxyRes.statusCode ?? 502;
                logger.debug("%s %s ← %d", req.method, req.path, status);

                res.status(status);

                for (const [key, value] of Object.entries(proxyRes.headers)) {
                  if (
                    !HOP_BY_HOP_HEADERS.has(key.toLowerCase()) &&
                    value !== undefined
                  ) {
                    res.setHeader(key, value);
                  }
                }

                span.addEvent("sidecar.proxy.request_forwarded", {
                  "sidecar.proxy.response_status": status,
                });

                proxyRes.pipe(res);
                proxyRes.on("end", () => resolve(status));
                proxyRes.on("error", reject);
              },
            );

            proxyReq.on("error", (err) => {
              logger.error("Proxy request failed: %s", err.message);
              if (!res.headersSent) {
                if (
                  (err as NodeJS.ErrnoException).code === "ECONNREFUSED"
                ) {
                  res
                    .status(502)
                    .json({ error: "Sidecar process is unavailable" });
                } else {
                  res
                    .status(502)
                    .json({ error: "Failed to proxy request to sidecar" });
                }
              }
              reject(err);
            });

            proxyReq.on("timeout", () => {
              proxyReq.destroy();
              if (!res.headersSent) {
                res.status(504).json({ error: "Sidecar request timed out" });
              }
              reject(
                Object.assign(new Error("Sidecar request timed out"), {
                  code: "ETIMEDOUT",
                }),
              );
            });

            req.pipe(proxyReq);
          });

          const duration = Date.now() - startTime;
          const metricAttrs = {
            "sidecar.proxy.path": req.path,
            "sidecar.proxy.method": req.method,
            "sidecar.proxy.status": statusCode,
          };
          this.metrics.requestCount.add(1, metricAttrs);
          this.metrics.requestDuration.record(duration, metricAttrs);

          span.setAttribute("sidecar.proxy.duration_ms", duration);
          span.setAttribute("sidecar.proxy.response_status", statusCode);
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          const duration = Date.now() - startTime;
          const errorType = classifyError(error as NodeJS.ErrnoException);

          span.recordException(error as Error);
          span.setAttribute("sidecar.proxy.error_type", errorType);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message,
          });

          this.metrics.errorCount.add(1, {
            "sidecar.proxy.path": req.path,
            "sidecar.proxy.error_type": errorType,
          });
          this.metrics.requestDuration.record(duration, {
            "sidecar.proxy.path": req.path,
            "sidecar.proxy.error": "true",
          });
        } finally {
          this.metrics.pendingGauge.add(-1);
        }
      },
    );
  }

  private buildTargetPath(originalPath: string): string {
    if (originalPath.includes("\0")) {
      throw SidecarError.proxyFailed(new Error("Invalid proxy path"));
    }

    const basePath = this.config.basePath.replace(/\/+$/, "") || "/";
    const normalized = posixPath.normalize(originalPath);
    const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
    const full = posixPath.normalize(`${basePath}${prefixed}`);

    if (!full.startsWith(basePath)) {
      throw SidecarError.proxyFailed(new Error("Invalid proxy path"));
    }

    return full;
  }

  private extractQueryString(url: string | undefined): string {
    if (!url) return "";
    const queryIndex = url.indexOf("?");
    return queryIndex >= 0 ? url.substring(queryIndex) : "";
  }

  private buildHeaders(req: IAppRequest): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {};

    if (this.config.forwardHeaders === "all") {
      for (const [key, value] of Object.entries(req.headers)) {
        if (
          value !== undefined &&
          key.toLowerCase() !== "host" &&
          !HOP_BY_HOP_HEADERS.has(key.toLowerCase())
        ) {
          headers[key] = value as string | string[];
        }
      }
    } else {
      for (const key of this.config.forwardHeaders) {
        const value = req.headers[key.toLowerCase()];
        if (value !== undefined) {
          headers[key.toLowerCase()] = value as string | string[];
        }
      }
      // Always forward auth-related headers
      const forwardUser = req.headers["x-forwarded-user"];
      if (forwardUser) headers["x-forwarded-user"] = forwardUser as string;
      const forwardToken = req.headers["x-forwarded-access-token"];
      if (forwardToken)
        headers["x-forwarded-access-token"] = forwardToken as string;
    }

    // Inject additional headers
    for (const [key, value] of Object.entries(this.config.injectHeaders)) {
      headers[key] = value;
    }

    // Rewrite host
    headers.host = `localhost:${this.port}`;

    return headers;
  }
}
