import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { MlflowUcConfig } from "./config";
import type { MlflowUcExportBatch, MlflowUcTraceExporter } from "./exporter";
import {
  buildMlflowUcTraceInfo,
  MLFLOW_EXPERIMENT_ID_ATTRIBUTE,
  MLFLOW_SPAN_TYPE_ATTRIBUTE,
  MLFLOW_TRACE_REQUEST_ID_ATTRIBUTE,
  MlflowUcTraceRegistry,
} from "./trace-info";

interface PendingTrace {
  spans: ReadableSpan[];
  memberSpanIds: Set<string>;
}

export class MlflowUcSpanProcessor implements SpanProcessor {
  private readonly pending = new Map<string, PendingTrace>();
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly config: MlflowUcConfig,
    private readonly exporter: MlflowUcTraceExporter,
    readonly registry = new MlflowUcTraceRegistry(config),
  ) {}

  onStart(span: Span, _parentContext: Context): void {
    if (this.closed) return;
    const spanContext = span.spanContext();
    const otelTraceId = spanContext.traceId;
    const mlflowTraceId = this.registry.ensureTrace(otelTraceId);
    span.setAttribute(MLFLOW_TRACE_REQUEST_ID_ATTRIBUTE, mlflowTraceId);
    span.setAttribute(MLFLOW_EXPERIMENT_ID_ATTRIBUTE, this.config.experimentId);

    let pending = this.pending.get(otelTraceId);
    if (!pending) {
      pending = { spans: [], memberSpanIds: new Set() };
      this.pending.set(otelTraceId, pending);
    }

    if (span.attributes[MLFLOW_SPAN_TYPE_ATTRIBUTE] === "AGENT") {
      if (this.registry.registerSemanticRoot(otelTraceId, spanContext.spanId)) {
        pending.memberSpanIds.add(spanContext.spanId);
      } else if (
        span.parentSpanContext &&
        pending.memberSpanIds.has(span.parentSpanContext.spanId)
      ) {
        pending.memberSpanIds.add(spanContext.spanId);
      }
      return;
    }

    if (
      span.parentSpanContext &&
      pending.memberSpanIds.has(span.parentSpanContext.spanId)
    ) {
      pending.memberSpanIds.add(spanContext.spanId);
    }
  }

  onEnd(span: ReadableSpan): void {
    if (this.closed) return;
    const spanContext = span.spanContext();
    const otelTraceId = spanContext.traceId;
    const pending = this.pending.get(otelTraceId);
    if (!pending) return;

    const semanticRootSpanId = this.registry.getSemanticRootSpanId(otelTraceId);
    if (!pending.memberSpanIds.has(spanContext.spanId)) {
      if (!span.parentSpanContext && !semanticRootSpanId) {
        this.pending.delete(otelTraceId);
      }
      return;
    }

    pending.spans.push(span);
    if (spanContext.spanId !== semanticRootSpanId) return;

    this.pending.delete(otelTraceId);
    const batch: MlflowUcExportBatch = {
      traceInfo: buildMlflowUcTraceInfo(this.config, span, pending.spans),
      spans: pending.spans,
    };
    this.startExport(batch);
  }

  async forceFlush(): Promise<void> {
    await this.exporter.forceFlush();
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.forceFlush();
    await this.exporter.shutdown();
  }

  private startExport(batch: MlflowUcExportBatch): void {
    let resolveExport!: () => void;
    const exportComplete = new Promise<void>((resolve) => {
      resolveExport = resolve;
    });
    this.inFlight.add(exportComplete);
    try {
      this.exporter.exportTrace(batch, () => resolveExport());
    } catch {
      resolveExport();
    }
    void exportComplete.finally(() => this.inFlight.delete(exportComplete));
  }
}
