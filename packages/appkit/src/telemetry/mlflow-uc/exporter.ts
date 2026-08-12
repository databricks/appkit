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
    const semanticRoot = spans.find(
      (span) => span.attributes["mlflow.spanType"] === "AGENT",
    );
    if (!semanticRoot) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    this.exportTrace(
      {
        traceInfo: buildMlflowUcTraceInfo(this.config, semanticRoot, spans),
        spans,
      },
      resultCallback,
    );
  }

  exportTrace(
    batch: MlflowUcExportBatch,
    resultCallback: (result: ExportResult) => void,
  ): void {
    if (this.closed) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    let operation!: Promise<void>;
    operation = this.exportBatch(batch)
      .catch((error) => {
        this.logger.error("MLflow UC trace export failed: %O", {
          event: "mlflow_uc_trace_export_failed",
          traceId: batch.traceInfo.trace_id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .then(() => {
        resultCallback({ code: ExportResultCode.SUCCESS });
      })
      .finally(() => {
        this.inFlight.delete(operation);
      });
    this.inFlight.add(operation);
  }

  async forceFlush(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.forceFlush();
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
