import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createLogger } from "../../logging/logger";
import type { MlflowUcConfig } from "./config";
import type { MlflowUcExportBatch, MlflowUcTraceExporter } from "./exporter";
import {
  buildMlflowUcTraceInfo,
  constructMlflowV4TraceId,
  MLFLOW_EXPERIMENT_ID_ATTRIBUTE,
  MLFLOW_SPAN_TYPE_ATTRIBUTE,
  MLFLOW_TRACE_REQUEST_ID_ATTRIBUTE,
  MlflowUcTraceRegistry,
} from "./trace-info";

interface PendingTrace {
  spans: ReadableSpan[];
  memberSpanIds: Set<string>;
  lastTouchedMs: number;
}

interface ProcessorOptions {
  maxConcurrentExports?: number;
  maxQueuedExports?: number;
}

interface QueuedExport {
  batch: MlflowUcExportBatch;
  resolve: () => void;
}

const MAX_PENDING_TRACES = 10_000;
const MAX_SPANS_PER_TRACE = 10_000;
const PENDING_TRACE_TTL_MS = 5 * 60_000;
const MAX_CONCURRENT_EXPORTS = 32;
const MAX_QUEUED_EXPORTS = 10_000;
const logger = createLogger("telemetry:mlflow-uc:processor");

export class MlflowUcSpanProcessor implements SpanProcessor {
  private readonly pending = new Map<string, PendingTrace>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly exportQueue: QueuedExport[] = [];
  private readonly maxConcurrentExports: number;
  private readonly maxQueuedExports: number;
  private activeExports = 0;
  private closed = false;
  private shutdownPromise?: Promise<void>;

  constructor(
    private readonly config: MlflowUcConfig,
    private readonly exporter: MlflowUcTraceExporter,
    readonly registry = new MlflowUcTraceRegistry(config),
    options: ProcessorOptions = {},
  ) {
    this.maxConcurrentExports = Math.max(
      1,
      Math.floor(options.maxConcurrentExports ?? MAX_CONCURRENT_EXPORTS),
    );
    this.maxQueuedExports = Math.max(
      1,
      Math.floor(options.maxQueuedExports ?? MAX_QUEUED_EXPORTS),
    );
  }

  onStart(span: Span, _parentContext: Context): void {
    if (this.closed) return;
    const now = Date.now();
    this.evictExpired(now);
    const spanContext = span.spanContext();
    const otelTraceId = spanContext.traceId;
    const mlflowTraceId =
      this.registry.getMlflowTraceId(otelTraceId) ??
      constructMlflowV4TraceId(this.config, otelTraceId);
    span.setAttribute(MLFLOW_TRACE_REQUEST_ID_ATTRIBUTE, mlflowTraceId);
    span.setAttribute(MLFLOW_EXPERIMENT_ID_ATTRIBUTE, this.config.experimentId);

    let pending = this.pending.get(otelTraceId);
    if (span.attributes[MLFLOW_SPAN_TYPE_ATTRIBUTE] === "AGENT") {
      const registeredRoot = this.registry.registerSemanticRoot(
        otelTraceId,
        spanContext.spanId,
      );
      if (!pending && registeredRoot) {
        this.ensurePendingCapacity();
        pending = { spans: [], memberSpanIds: new Set(), lastTouchedMs: now };
        this.pending.set(otelTraceId, pending);
      }
      if (!pending) return;
      pending.lastTouchedMs = now;

      if (registeredRoot) {
        pending.memberSpanIds.add(spanContext.spanId);
      } else if (
        span.parentSpanContext &&
        pending.memberSpanIds.has(span.parentSpanContext.spanId) &&
        pending.memberSpanIds.size < MAX_SPANS_PER_TRACE
      ) {
        pending.memberSpanIds.add(spanContext.spanId);
      }
      return;
    }

    if (
      pending &&
      span.parentSpanContext &&
      pending.memberSpanIds.has(span.parentSpanContext.spanId) &&
      pending.memberSpanIds.size < MAX_SPANS_PER_TRACE
    ) {
      pending.memberSpanIds.add(spanContext.spanId);
    }
  }

  onEnd(span: ReadableSpan): void {
    if (this.closed) return;
    const now = Date.now();
    this.evictExpired(now);
    const spanContext = span.spanContext();
    const otelTraceId = spanContext.traceId;
    const pending = this.pending.get(otelTraceId);
    if (!pending) return;

    const semanticRootSpanId = this.registry.getSemanticRootSpanId(otelTraceId);
    if (!pending.memberSpanIds.has(spanContext.spanId)) {
      return;
    }
    pending.lastTouchedMs = now;

    const isSemanticRoot = spanContext.spanId === semanticRootSpanId;
    if (isSemanticRoot) {
      if (pending.spans.length >= MAX_SPANS_PER_TRACE) {
        pending.spans.length = MAX_SPANS_PER_TRACE - 1;
      }
      pending.spans.push(span);
    } else if (pending.spans.length < MAX_SPANS_PER_TRACE - 1) {
      pending.spans.push(span);
    }
    if (!isSemanticRoot) return;

    this.pending.delete(otelTraceId);
    this.registry.deleteTrace(otelTraceId);
    const batch: MlflowUcExportBatch = {
      traceInfo: buildMlflowUcTraceInfo(this.config, span, pending.spans),
      spans: pending.spans,
    };
    this.startExport(batch);
  }

  async forceFlush(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
    await this.exporter.forceFlush();
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.closed = true;
      this.shutdownPromise = (async () => {
        await this.forceFlush();
        this.pending.clear();
        this.registry.clear();
        await this.exporter.shutdown();
      })();
    }
    await this.shutdownPromise;
  }

  private startExport(batch: MlflowUcExportBatch): void {
    if (
      this.activeExports >= this.maxConcurrentExports &&
      this.exportQueue.length >= this.maxQueuedExports
    ) {
      logger.error("Dropped completed MLflow UC trace before export: %O", {
        event: "mlflow_uc_completed_trace_dropped",
        traceId: batch.traceInfo.trace_id,
        reason: "export_queue_capacity",
        queuedExports: this.exportQueue.length,
      });
      return;
    }
    let resolveExport!: () => void;
    const exportComplete = new Promise<void>((resolve) => {
      resolveExport = resolve;
    });
    this.inFlight.add(exportComplete);
    this.exportQueue.push({ batch, resolve: resolveExport });
    void exportComplete.finally(() => this.inFlight.delete(exportComplete));
    this.drainExports();
  }

  private drainExports(): void {
    while (
      this.activeExports < this.maxConcurrentExports &&
      this.exportQueue.length > 0
    ) {
      const queued = this.exportQueue.shift();
      if (!queued) return;
      this.activeExports += 1;
      let completed = false;
      const complete = () => {
        if (completed) return;
        completed = true;
        this.activeExports -= 1;
        queued.resolve();
        queueMicrotask(() => this.drainExports());
      };
      try {
        this.exporter.exportTrace(queued.batch, complete);
      } catch {
        complete();
      }
    }
  }

  private ensurePendingCapacity(): void {
    while (this.pending.size >= MAX_PENDING_TRACES) {
      const oldestTraceId = this.pending.keys().next().value as
        | string
        | undefined;
      if (!oldestTraceId) return;
      this.evictTrace(oldestTraceId, "capacity");
    }
  }

  private evictExpired(now: number): void {
    for (const [traceId, pending] of this.pending) {
      if (now - pending.lastTouchedMs <= PENDING_TRACE_TTL_MS) continue;
      this.evictTrace(traceId, "ttl");
    }
  }

  private evictTrace(traceId: string, reason: "capacity" | "ttl"): void {
    const pending = this.pending.get(traceId);
    if (!pending) return;
    this.pending.delete(traceId);
    this.registry.deleteTrace(traceId);
    logger.error("Dropped incomplete MLflow UC trace: %O", {
      event: "mlflow_uc_incomplete_trace_dropped",
      traceId,
      reason,
      retainedSpans: pending.spans.length,
      memberSpans: pending.memberSpanIds.size,
    });
  }
}
