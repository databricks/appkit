import type { Readable, Writable } from "node:stream";
import type { Counter, Histogram, UpDownCounter } from "@opentelemetry/api";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { StdioResponsePayload } from "shared";
import { SidecarError } from "../../errors/sidecar";
import { createLogger } from "../../logging/logger";
import type { ITelemetry } from "../../telemetry/types";
import type { StdioConfig } from "./types";

const logger = createLogger("sidecar:stdio-bridge");

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

interface StdioRequestParams {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface PendingRequest {
  resolve: (result: StdioResponsePayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_STDIO_CONFIG = {
  requestTimeout: 30_000,
  pingInterval: 10_000,
  pingFailureThreshold: 3,
  maxConcurrency: 50,
};

export class StdioBridge {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private ready = false;
  private readyResolve: (() => void) | null = null;
  private lineBuffer = "";
  private consecutiveFailures = 0;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private stdin: Writable | null = null;
  private stdout: Readable | null = null;
  private stdoutHandler: ((chunk: Buffer) => void) | null = null;

  private readonly config: Required<Omit<StdioConfig, "onNotification">>;
  private readonly onNotification?: (method: string, params: unknown) => void;
  private readonly telemetry: ITelemetry;
  private readonly metrics: {
    requestCount: Counter;
    requestDuration: Histogram;
    errorCount: Counter;
    pendingGauge: UpDownCounter;
    healthCheckCount: Counter;
  };

  constructor(config: StdioConfig, telemetry: ITelemetry) {
    this.config = {
      requestTimeout:
        config.requestTimeout ?? DEFAULT_STDIO_CONFIG.requestTimeout,
      pingInterval: config.pingInterval ?? DEFAULT_STDIO_CONFIG.pingInterval,
      pingFailureThreshold:
        config.pingFailureThreshold ??
        DEFAULT_STDIO_CONFIG.pingFailureThreshold,
      maxConcurrency:
        config.maxConcurrency ?? DEFAULT_STDIO_CONFIG.maxConcurrency,
    };
    this.onNotification = config.onNotification;
    this.telemetry = telemetry;

    const meter = this.telemetry.getMeter();
    this.metrics = {
      requestCount: meter.createCounter("sidecar.stdio.request.count", {
        description: "Total stdio requests sent to child process",
        unit: "1",
      }),
      requestDuration: meter.createHistogram("sidecar.stdio.request.duration", {
        description: "Round-trip time for stdio request→response",
        unit: "ms",
      }),
      errorCount: meter.createCounter("sidecar.stdio.error.count", {
        description: "Total stdio errors (timeout, protocol, concurrency)",
        unit: "1",
      }),
      pendingGauge: meter.createUpDownCounter("sidecar.stdio.pending", {
        description: "Currently pending (in-flight) requests",
        unit: "1",
      }),
      healthCheckCount: meter.createCounter("sidecar.stdio.healthcheck.count", {
        description: "Health check ping attempts",
        unit: "1",
      }),
    };
  }

  attach(stdin: Writable, stdout: Readable): void {
    this.stdin = stdin;
    this.stdout = stdout;
    this.stdoutHandler = (chunk: Buffer) => this.onStdoutData(chunk);
    this.stdout.on("data", this.stdoutHandler);
  }

  detach(): void {
    if (this.stdout && this.stdoutHandler) {
      this.stdout.removeListener("data", this.stdoutHandler);
    }
    this.stdin = null;
    this.stdout = null;
    this.stdoutHandler = null;
    this.lineBuffer = "";
    this.ready = false;
  }

  async waitForReady(timeout: number): Promise<boolean> {
    if (this.ready) return true;

    return this.telemetry.startActiveSpan(
      "sidecar.stdio.startup",
      {
        kind: SpanKind.INTERNAL,
        attributes: { "sidecar.stdio.timeout": timeout },
      },
      async (span) => {
        try {
          const result = await Promise.race([
            new Promise<"notification">((resolve) => {
              this.readyResolve = () => resolve("notification");
            }),
            this.ping(5_000).then((ok) => (ok ? ("ping" as const) : null)),
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), timeout),
            ),
          ]);

          const readySignal = result ?? "timeout";
          span.setAttribute("sidecar.stdio.ready_signal", readySignal);

          if (result) {
            this.ready = true;
            span.setStatus({ code: SpanStatusCode.OK });
            return true;
          }

          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: "Startup timeout",
          });
          return false;
        } finally {
          this.readyResolve = null;
        }
      },
    );
  }

  async sendRequest(params: StdioRequestParams): Promise<StdioResponsePayload> {
    if (this.pending.size >= this.config.maxConcurrency) {
      this.metrics.errorCount.add(1, {
        "sidecar.stdio.error_type": "concurrency_exhausted",
      });
      throw SidecarError.concurrencyExhausted(this.config.maxConcurrency);
    }

    const id = this.nextId++;
    const startTime = Date.now();

    return this.telemetry.startActiveSpan(
      "sidecar.stdio.request",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "sidecar.stdio.request_id": id,
          "sidecar.stdio.path": params.path,
          "sidecar.stdio.method": params.method ?? "POST",
          "sidecar.stdio.pending_count": this.pending.size,
        },
      },
      async (span) => {
        this.metrics.pendingGauge.add(1);

        try {
          const message: JsonRpcRequest = {
            jsonrpc: "2.0",
            id,
            method: "request",
            params,
          };
          this.write(message);
          span.addEvent("sidecar.stdio.message_sent", {
            "sidecar.stdio.id": id,
          });

          const result = await this.waitForResponse(id);

          const duration = Date.now() - startTime;
          span.setAttribute("sidecar.stdio.duration_ms", duration);
          span.setAttribute(
            "sidecar.stdio.response_status",
            result.status ?? 200,
          );
          span.setStatus({ code: SpanStatusCode.OK });

          const metricAttrs = {
            "sidecar.stdio.path": params.path,
            "sidecar.stdio.method": params.method ?? "POST",
            "sidecar.stdio.status": result.status ?? 200,
          };
          this.metrics.requestCount.add(1, metricAttrs);
          this.metrics.requestDuration.record(duration, metricAttrs);

          return result;
        } catch (error) {
          const duration = Date.now() - startTime;
          const errorType =
            error instanceof SidecarError
              ? ((error.context?.errorType as string) ?? "bridge_error")
              : "unknown";

          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message,
          });
          span.setAttribute("sidecar.stdio.error_type", errorType);

          this.metrics.errorCount.add(1, {
            "sidecar.stdio.path": params.path,
            "sidecar.stdio.error_type": errorType,
          });
          this.metrics.requestDuration.record(duration, {
            "sidecar.stdio.path": params.path,
            "sidecar.stdio.error": "true",
          });

          throw error;
        } finally {
          this.metrics.pendingGauge.add(-1);
        }
      },
    );
  }

  async ping(timeout?: number): Promise<boolean> {
    const id = this.nextId++;
    const pingTimeout = timeout ?? this.config.requestTimeout;

    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method: "ping",
      params: {},
    };

    try {
      logger.info("Sending ping request to sidecar", message);
      this.write(message);
      await this.waitForResponse(id, pingTimeout);
      return true;
    } catch {
      return false;
    }
  }

  startHealthCheck(callbacks: {
    onHealthy: () => void;
    onUnhealthy: () => void;
  }): void {
    this.healthInterval = setInterval(async () => {
      const healthy = await this.ping();

      this.metrics.healthCheckCount.add(1, {
        "sidecar.stdio.healthy": healthy,
      });

      if (healthy) {
        this.consecutiveFailures = 0;
        callbacks.onHealthy();
      } else {
        this.consecutiveFailures++;
        logger.warn(
          "Sidecar stdio ping failed (%d/%d)",
          this.consecutiveFailures,
          this.config.pingFailureThreshold,
        );
        if (this.consecutiveFailures >= this.config.pingFailureThreshold) {
          callbacks.onUnhealthy();
          this.consecutiveFailures = 0;
        }
      }
    }, this.config.pingInterval);
  }

  destroy(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }

    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new SidecarError("Sidecar bridge destroyed", { statusCode: 503 }),
      );
    }
    this.pending.clear();

    this.detach();
  }

  private write(message: JsonRpcRequest): void {
    if (!this.stdin || this.stdin.destroyed) {
      throw SidecarError.stdinWriteFailed();
    }
    const line = `${JSON.stringify(message)}\n`;
    const ok = this.stdin.write(line);
    if (!ok) {
      // Backpressure — for now we just log. The write is still queued.
      logger.debug("sidecar stdin backpressure on message id=%d", message.id);
    }
  }

  private waitForResponse(
    id: number,
    timeout?: number,
  ): Promise<StdioResponsePayload> {
    const requestTimeout = timeout ?? this.config.requestTimeout;
    return new Promise<StdioResponsePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(SidecarError.bridgeTimeout(id, requestTimeout));
      }, requestTimeout);

      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private onStdoutData(chunk: Buffer): void {
    this.lineBuffer += chunk.toString();
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        // Not JSON — treat as plain log output
        logger.debug("sidecar stdout (non-JSON): %s", line);
      }
    }
  }

  private handleMessage(msg: unknown): void {
    if (
      typeof msg !== "object" ||
      msg === null ||
      (msg as Record<string, unknown>).jsonrpc !== "2.0"
    ) {
      logger.debug("sidecar stdout (invalid JSON-RPC): %O", msg);
      return;
    }

    const m = msg as Record<string, unknown>;

    if ("id" in m && (m.result !== undefined || m.error !== undefined)) {
      // Response — correlate to pending request
      const id = m.id as number;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);

      if (m.error) {
        const err = m.error as {
          code: number;
          message: string;
          data?: unknown;
        };
        pending.reject(
          SidecarError.bridgeRequestFailed(err.message, {
            code: err.code,
            data: err.data,
          }),
        );
      } else {
        pending.resolve((m.result ?? {}) as StdioResponsePayload);
      }
    } else if ("method" in m && !("id" in m)) {
      this.handleNotification(m as unknown as JsonRpcNotification);
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    switch (msg.method) {
      case "ready":
        this.ready = true;
        this.readyResolve?.();
        break;
      case "log":
        logger.info(
          "sidecar: %s",
          (msg.params as Record<string, unknown>)?.message,
        );
        break;
      default:
        this.onNotification?.(msg.method, msg.params);
        break;
    }
  }
}
