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
import { buildMlflowUcTraceInfo, type MlflowUcTraceInfo } from "./trace-info";

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
    headers: Record<string, string>;
  }) => SpanExporter;
  logger?: LoggerLike;
}

export class MlflowUcSpanExporter
  implements SpanExporter, MlflowUcTraceExporter
{
  private readonly inFlight = new Set<Promise<void>>();
  private readonly pendingSpans = new Map<string, Map<string, ReadableSpan>>();
  private readonly createOtlpExporter: NonNullable<
    ExporterOptions["createOtlpExporter"]
  >;
  private readonly logger: LoggerLike;
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
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    if (this.closed) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    const batches = this.accumulateReadyBatches(spans);
    if (batches.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    const operation = (async () => {
      for (const batch of batches) {
        await this.exportBatchSafely(batch);
      }
      resultCallback({ code: ExportResultCode.SUCCESS });
    })();
    this.track(operation);
  }

  exportTrace(
    batch: MlflowUcExportBatch,
    resultCallback: (result: ExportResult) => void,
  ): void {
    if (this.closed) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    const operation = this.exportBatchSafely(batch).then(() => {
      resultCallback({ code: ExportResultCode.SUCCESS });
    });
    this.track(operation);
  }

  async forceFlush(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.forceFlush();
    this.pendingSpans.clear();
  }

  private accumulateReadyBatches(spans: ReadableSpan[]): MlflowUcExportBatch[] {
    const batches: MlflowUcExportBatch[] = [];
    for (const [traceId, newSpans] of groupSpansByTrace(spans)) {
      const accumulated = this.pendingSpans.get(traceId) ?? new Map();
      for (const span of newSpans) {
        accumulated.set(span.spanContext().spanId, span);
      }
      this.pendingSpans.set(traceId, accumulated);

      const traceSpans = [...accumulated.values()];
      const semanticRoot = findSemanticRoot(traceSpans);
      if (semanticRoot) {
        const semanticSpans = findSemanticSubtree(traceSpans, semanticRoot);
        this.pendingSpans.delete(traceId);
        batches.push({
          traceInfo: buildMlflowUcTraceInfo(
            this.config,
            semanticRoot,
            semanticSpans,
          ),
          spans: semanticSpans,
        });
      }
    }
    return batches;
  }

  private async exportBatchSafely(batch: MlflowUcExportBatch): Promise<void> {
    try {
      await this.exportBatch(batch);
    } catch (error) {
      this.logger.error("MLflow UC trace export failed: %O", {
        event: "mlflow_uc_trace_export_failed",
        traceId: batch.traceInfo.trace_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private track(operation: Promise<void>): void {
    this.inFlight.add(operation);
    void operation.then(
      () => this.inFlight.delete(operation),
      () => this.inFlight.delete(operation),
    );
  }

  private async exportBatch(batch: MlflowUcExportBatch): Promise<void> {
    await this.client.config.ensureResolved();
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
    const otelTraceId = traceInfo.trace_id.slice(
      traceInfo.trace_id.lastIndexOf("/") + 1,
    );
    const traceInfoResponse = await fetch(
      `${host}/api/4.0/mlflow/traces/${encodeURIComponent(location)}/${encodeURIComponent(otelTraceId)}/info`,
      {
        method: "POST",
        headers: {
          ...traceInfoHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(traceInfo),
      },
    );
    if (!traceInfoResponse.ok) {
      throw new Error(
        `MLflow trace-info request failed with ${traceInfoResponse.status}: ${await traceInfoResponse.text()}`,
      );
    }

    const otlpAuthHeaders = await this.freshAuthHeaders();
    const otlpExporter = this.createOtlpExporter({
      url: `${host}/api/2.0/otel/v1/traces`,
      headers: {
        ...otlpAuthHeaders,
        "X-Databricks-UC-Table-Name": this.config.otelSpansTableName,
      },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        otlpExporter.export(batch.spans, (result) => {
          if (result.code === ExportResultCode.SUCCESS) resolve();
          else reject(result.error ?? new Error("OTLP trace upload failed"));
        });
      });
    } finally {
      await otlpExporter.shutdown();
    }
  }

  private async freshAuthHeaders(): Promise<Record<string, string>> {
    const headers = new Headers();
    await this.client.config.authenticate(headers);
    return Object.fromEntries(headers.entries());
  }
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
