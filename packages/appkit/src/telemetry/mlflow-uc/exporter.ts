import { isSpanContextValid } from "@opentelemetry/api";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { createLogger } from "../../logging/logger";
import {
  createWorkspaceClient,
  type WorkspaceClient,
} from "../../workspace-client";
import type { MlflowUcConfig } from "./config";
import {
  buildMlflowUcTraceInfo,
  constructMlflowV4TraceId,
  type MlflowUcTraceInfo,
} from "./trace-info";

const logger = createLogger("telemetry:mlflow-uc");

export interface MlflowUcExportBatch {
  traceInfo: MlflowUcTraceInfo;
  spans: ReadableSpan[];
}

export interface MlflowUcTraceExporter {
  exportTrace(
    batch: MlflowUcExportBatch,
    resultCallback: (result: ExportResult) => void,
  ): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

interface LoggerLike {
  error(message: string, ...args: unknown[]): void;
}

interface ExporterOptions {
  createOtlpExporter?: (options: {
    url: string;
    headers: Record<string, string> | (() => Promise<Record<string, string>>);
    timeoutMillis?: number;
  }) => SpanExporter;
  logger?: LoggerLike;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  operationTimeoutMs?: number;
  maxPendingTraces?: number;
  maxSpansPerTrace?: number;
  pendingTraceTtlMs?: number;
  now?: () => number;
}

interface PendingSpanTrace {
  spans: Map<string, ReadableSpan>;
  lastTouchedMs: number;
}

const MAX_PENDING_TRACES = 10_000;
const MAX_SPANS_PER_TRACE = 10_000;
const PENDING_TRACE_TTL_MS = 5 * 60_000;

class TraceInfoRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class MlflowUcSpanExporter
  implements SpanExporter, MlflowUcTraceExporter
{
  private readonly inFlight = new Set<Promise<void>>();
  private readonly pendingSpans = new Map<string, PendingSpanTrace>();
  private readonly createOtlpExporter: NonNullable<
    ExporterOptions["createOtlpExporter"]
  >;
  private readonly logger: LoggerLike;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly operationTimeoutMs: number;
  private readonly maxPendingTraces: number;
  private readonly maxSpansPerTrace: number;
  private readonly pendingTraceTtlMs: number;
  private readonly now: () => number;
  private otlpExporter?: SpanExporter;
  private shutdownPromise?: Promise<void>;
  private closed = false;

  constructor(
    private readonly config: MlflowUcConfig,
    private readonly client: WorkspaceClient = createWorkspaceClient(),
    options: ExporterOptions = {},
  ) {
    this.createOtlpExporter =
      options.createOtlpExporter ??
      ((exporterOptions) => new OTLPTraceExporter(exporterOptions));
    this.logger = options.logger ?? logger;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 100);
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.operationTimeoutMs = Math.max(1, options.operationTimeoutMs ?? 10_000);
    this.maxPendingTraces = Math.max(
      1,
      Math.floor(options.maxPendingTraces ?? MAX_PENDING_TRACES),
    );
    this.maxSpansPerTrace = Math.max(
      1,
      Math.floor(options.maxSpansPerTrace ?? MAX_SPANS_PER_TRACE),
    );
    this.pendingTraceTtlMs = Math.max(
      1,
      options.pendingTraceTtlMs ?? PENDING_TRACE_TTL_MS,
    );
    this.now = options.now ?? Date.now;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    if (this.closed) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error("MLflow UC trace exporter is shut down"),
      });
      return;
    }

    const batches = this.accumulateReadyBatches(spans);
    if (batches.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    const operation = (async () => {
      try {
        for (const batch of batches) {
          await this.exportBatchWithRetry(batch);
        }
        resultCallback({ code: ExportResultCode.SUCCESS });
      } catch (error) {
        resultCallback({
          code: ExportResultCode.FAILED,
          error: toError(error),
        });
      }
    })();
    this.track(operation);
  }

  exportTrace(
    batch: MlflowUcExportBatch,
    resultCallback: (result: ExportResult) => void,
  ): void {
    if (this.closed) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error("MLflow UC trace exporter is shut down"),
      });
      return;
    }

    const operation = this.exportBatchWithRetry(batch).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      (error) =>
        resultCallback({
          code: ExportResultCode.FAILED,
          error: toError(error),
        }),
    );
    this.track(operation);
  }

  async forceFlush(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.closed = true;
      this.shutdownPromise = (async () => {
        await this.forceFlush();
        this.pendingSpans.clear();
        const otlpExporter = this.otlpExporter;
        this.otlpExporter = undefined;
        if (otlpExporter) await otlpExporter.shutdown();
      })();
    }
    await this.shutdownPromise;
  }

  private accumulateReadyBatches(spans: ReadableSpan[]): MlflowUcExportBatch[] {
    const batches: MlflowUcExportBatch[] = [];
    const now = this.now();
    this.evictExpiredPendingTraces(now);
    for (const [traceId, newSpans] of groupSpansByTrace(spans)) {
      const pending = this.pendingSpans.get(traceId);
      const accumulated = new Map(pending?.spans);
      for (const span of newSpans) {
        accumulated.set(span.spanContext().spanId, span);
      }

      const traceSpans = [...accumulated.values()];
      const semanticRoot = findSemanticRoot(traceSpans);
      if (semanticRoot) {
        const semanticSpans = this.capCompletedTrace(
          findSemanticSubtree(traceSpans, semanticRoot),
          semanticRoot,
        );
        this.pendingSpans.delete(traceId);
        batches.push({
          traceInfo: buildMlflowUcTraceInfo(
            this.config,
            semanticRoot,
            semanticSpans,
          ),
          spans: semanticSpans,
        });
        continue;
      }

      if (!pending) this.ensurePendingSpanCapacity();
      const retained = pending ?? { spans: new Map(), lastTouchedMs: now };
      retained.lastTouchedMs = now;
      retained.spans.clear();
      for (const [spanId, span] of accumulated) {
        if (retained.spans.size >= this.maxSpansPerTrace) break;
        retained.spans.set(spanId, span);
      }
      this.pendingSpans.set(traceId, retained);
    }
    return batches;
  }

  private capCompletedTrace(
    spans: ReadableSpan[],
    semanticRoot: ReadableSpan,
  ): ReadableSpan[] {
    if (spans.length <= this.maxSpansPerTrace) return spans;
    const retained = spans.slice(0, this.maxSpansPerTrace);
    const semanticRootId = semanticRoot.spanContext().spanId;
    if (retained.some((span) => span.spanContext().spanId === semanticRootId)) {
      return retained;
    }
    retained[retained.length - 1] = semanticRoot;
    return retained;
  }

  private ensurePendingSpanCapacity(): void {
    while (this.pendingSpans.size >= this.maxPendingTraces) {
      const oldestTraceId = this.pendingSpans.keys().next().value as
        | string
        | undefined;
      if (!oldestTraceId) return;
      this.evictPendingTrace(oldestTraceId, "capacity");
    }
  }

  private evictExpiredPendingTraces(now: number): void {
    for (const [traceId, pending] of this.pendingSpans) {
      if (now - pending.lastTouchedMs <= this.pendingTraceTtlMs) continue;
      this.evictPendingTrace(traceId, "ttl");
    }
  }

  private evictPendingTrace(traceId: string, reason: "capacity" | "ttl"): void {
    const pending = this.pendingSpans.get(traceId);
    if (!pending) return;
    this.pendingSpans.delete(traceId);
    this.logger.error("Dropped incomplete MLflow UC trace: %O", {
      event: "mlflow_uc_incomplete_trace_dropped",
      traceId,
      reason,
      retainedSpans: pending.spans.size,
    });
  }

  private async exportBatchWithRetry(
    batch: MlflowUcExportBatch,
  ): Promise<void> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        await this.exportBatch(batch);
        return;
      } catch (error) {
        lastError = toError(error);
        if (attempt >= this.maxAttempts || !isRetryableExportError(error)) {
          break;
        }
        const retryAfterMs =
          error instanceof TraceInfoRequestError
            ? error.retryAfterMs
            : undefined;
        await this.sleep(
          Math.min(
            this.operationTimeoutMs,
            retryAfterMs ?? this.retryDelayMs * 2 ** (attempt - 1),
          ),
        );
      }
    }
    const terminalError =
      lastError ?? new Error("MLflow UC trace export failed");
    this.logger.error("MLflow UC trace export failed: %O", {
      event: "mlflow_uc_trace_export_failed",
      traceId: constructMlflowV4TraceId(this.config, batch.traceInfo.trace_id),
      error: terminalError.message,
    });
    throw terminalError;
  }

  private track(operation: Promise<void>): void {
    this.inFlight.add(operation);
    void operation.then(
      () => this.inFlight.delete(operation),
      () => this.inFlight.delete(operation),
    );
  }

  private async exportBatch(batch: MlflowUcExportBatch): Promise<void> {
    await this.withDeadline(
      this.client.config.ensureResolved(),
      "workspace configuration",
    );
    const configuredHost = this.client.config.host;
    if (!configuredHost) {
      throw new Error(
        "Databricks workspace host is unavailable for MLflow UC export",
      );
    }
    const host = configuredHost.replace(/\/$/, "");
    const traceInfoHeaders = await this.freshAuthHeaders();
    const { traceInfo } = batch;
    const location = `${this.config.catalogName}.${this.config.schemaName}.${this.config.tablePrefix}`;
    const traceInfoResponse = await fetch(
      `${host}/api/4.0/mlflow/traces/${encodeURIComponent(location)}/${encodeURIComponent(traceInfo.trace_id)}/info`,
      {
        method: "POST",
        headers: {
          ...traceInfoHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(traceInfo),
        signal: AbortSignal.timeout(this.operationTimeoutMs),
      },
    );
    if (!traceInfoResponse.ok) {
      throw new TraceInfoRequestError(
        traceInfoResponse.status,
        `MLflow trace-info request failed with ${traceInfoResponse.status}: ${await traceInfoResponse.text()}`,
        parseRetryAfter(traceInfoResponse.headers.get("retry-after")),
      );
    }
    await traceInfoResponse.body?.cancel();

    const otlpExporter = this.getOrCreateOtlpExporter(host);
    await new Promise<void>((resolve, reject) => {
      otlpExporter.export(batch.spans, (result) => {
        if (result.code === ExportResultCode.SUCCESS) resolve();
        else reject(result.error ?? new Error("OTLP trace upload failed"));
      });
    });
  }

  private getOrCreateOtlpExporter(host: string): SpanExporter {
    if (this.otlpExporter) return this.otlpExporter;
    this.otlpExporter = this.createOtlpExporter({
      url: `${host}/api/2.0/otel/v1/traces`,
      headers: async () => ({
        ...(await this.freshAuthHeaders()),
        "X-Databricks-UC-Table-Name": this.config.otelSpansTableName,
      }),
      timeoutMillis: this.operationTimeoutMs,
    });
    return this.otlpExporter;
  }

  private async freshAuthHeaders(): Promise<Record<string, string>> {
    const headers = new Headers();
    await this.withDeadline(
      this.client.config.authenticate(headers),
      "workspace authentication",
    );
    return Object.fromEntries(headers.entries());
  }

  private async withDeadline<T>(
    operation: Promise<T>,
    label: string,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new Error(
              `MLflow UC ${label} timed out after ${this.operationTimeoutMs}ms`,
            ),
          ),
        this.operationTimeoutMs,
      );
    });
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function isRetryableExportError(error: unknown): boolean {
  if (error instanceof TraceInfoRequestError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  const candidate = error as { name?: unknown; code?: unknown };
  if (
    candidate?.name === "OTLPExporterError" &&
    typeof candidate.code === "number"
  ) {
    return (
      candidate.code === 408 || candidate.code === 429 || candidate.code >= 500
    );
  }
  if (typeof candidate?.code === "string") {
    return new Set([
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND",
      "ENETUNREACH",
      "EHOSTUNREACH",
    ]).has(candidate.code);
  }
  return !toError(error).message.includes(
    "Databricks workspace host is unavailable",
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function groupSpansByTrace(spans: ReadableSpan[]): Map<string, ReadableSpan[]> {
  const grouped = new Map<string, ReadableSpan[]>();
  for (const span of spans) {
    const traceId = span.spanContext().traceId;
    const traceSpans = grouped.get(traceId) ?? [];
    traceSpans.push(span);
    grouped.set(traceId, traceSpans);
  }
  return grouped;
}

function findSemanticRoot(spans: ReadableSpan[]): ReadableSpan | undefined {
  const bySpanId = new Map(
    spans.map((span) => [span.spanContext().spanId, span]),
  );
  return spans.find((span) => {
    if (span.attributes["mlflow.spanType"] !== "AGENT") return false;

    let parent = span.parentSpanContext;
    while (parent) {
      if (!isSpanContextValid(parent)) return true;
      const parentSpan = bySpanId.get(parent.spanId);
      if (!parentSpan) return parent.isRemote === true;
      if (parentSpan.attributes["mlflow.spanType"] === "AGENT") return false;
      parent = parentSpan.parentSpanContext;
    }
    return true;
  });
}

function findSemanticSubtree(
  spans: ReadableSpan[],
  semanticRoot: ReadableSpan,
): ReadableSpan[] {
  const bySpanId = new Map(
    spans.map((span) => [span.spanContext().spanId, span]),
  );
  const semanticRootId = semanticRoot.spanContext().spanId;

  return spans.filter((span) => {
    let current: ReadableSpan | undefined = span;
    const visited = new Set<string>();
    while (current) {
      const spanId = current.spanContext().spanId;
      if (spanId === semanticRootId) return true;
      if (visited.has(spanId)) return false;
      visited.add(spanId);

      const parentSpanContext: ReadableSpan["parentSpanContext"] =
        current.parentSpanContext;
      current = parentSpanContext
        ? bySpanId.get(parentSpanContext.spanId)
        : undefined;
    }
    return false;
  });
}
