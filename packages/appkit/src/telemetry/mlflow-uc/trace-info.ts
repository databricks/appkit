import type { Attributes, HrTime } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { MlflowUcConfig } from "./config";

export const MLFLOW_TRACE_REQUEST_ID_ATTRIBUTE = "mlflow.traceRequestId";
export const MLFLOW_EXPERIMENT_ID_ATTRIBUTE = "mlflow.experimentId";
export const MLFLOW_SPAN_TYPE_ATTRIBUTE = "mlflow.spanType";

const TRACE_METADATA_IDENTITIES = [
  "mlflow.trace.session",
  "mlflow.trace.user",
  "mlflow.sourceRun",
  "appkit.app.name",
  "appkit.request.id",
  "appkit.thread.id",
  "appkit.agent.name",
  "appkit.route",
] as const;

export interface MlflowUcTraceInfo {
  trace_id: string;
  client_request_id?: string;
  trace_location: {
    type: "UC_TABLE_PREFIX";
    uc_table_prefix: {
      catalog_name: string;
      schema_name: string;
      table_prefix: string;
      otel_spans_table_name: string;
    };
  };
  request_preview?: string;
  response_preview?: string;
  request_time: string;
  execution_duration: string;
  state: "OK" | "ERROR";
  trace_metadata: Record<string, string>;
  tags: Record<string, string>;
  assessments: [];
}

interface RegisteredTrace {
  mlflowTraceId: string;
  semanticRootSpanId?: string;
}

/**
 * Maps the process-local OTel trace identity to MLflow's V4 identity.
 *
 * The semantic root is registered independently from the OTel root. This is
 * intentional: an auto-instrumented HTTP span can be the OTel parent while an
 * AGENT span is the record represented by MLflow TraceInfo. Task-level tracing
 * helpers can register or query that semantic root without changing provider
 * ownership or exporter wiring.
 */
export class MlflowUcTraceRegistry {
  private readonly traces = new Map<string, RegisteredTrace>();

  constructor(private readonly config: MlflowUcConfig) {}

  ensureTrace(otelTraceId: string): string {
    const existing = this.traces.get(otelTraceId);
    if (existing) return existing.mlflowTraceId;

    const mlflowTraceId = constructMlflowV4TraceId(this.config, otelTraceId);
    this.traces.set(otelTraceId, { mlflowTraceId });
    return mlflowTraceId;
  }

  registerSemanticRoot(otelTraceId: string, spanId: string): boolean {
    const registered = this.getOrCreateTrace(otelTraceId);
    if (registered.semanticRootSpanId) {
      return registered.semanticRootSpanId === spanId;
    }
    registered.semanticRootSpanId = spanId;
    return true;
  }

  getMlflowTraceId(otelTraceId: string): string | undefined {
    return this.traces.get(otelTraceId)?.mlflowTraceId;
  }

  getSemanticRootSpanId(otelTraceId: string): string | undefined {
    return this.traces.get(otelTraceId)?.semanticRootSpanId;
  }

  deleteTrace(otelTraceId: string): void {
    this.traces.delete(otelTraceId);
  }

  clear(): void {
    this.traces.clear();
  }

  private getOrCreateTrace(otelTraceId: string): RegisteredTrace {
    this.ensureTrace(otelTraceId);
    return (
      this.traces.get(otelTraceId) ?? {
        mlflowTraceId: constructMlflowV4TraceId(this.config, otelTraceId),
      }
    );
  }
}

let activeTraceRegistry: MlflowUcTraceRegistry | undefined;

export function setActiveMlflowUcTraceRegistry(
  registry: MlflowUcTraceRegistry | undefined,
): void {
  activeTraceRegistry = registry;
}

export function getMlflowUcTraceId(otelTraceId: string): string | undefined {
  return activeTraceRegistry?.getMlflowTraceId(otelTraceId);
}

export function constructMlflowV4TraceId(
  config: MlflowUcConfig,
  otelTraceId: string,
): string {
  return `trace:/${config.catalogName}.${config.schemaName}.${config.tablePrefix}/${otelTraceId}`;
}

export function buildMlflowUcTraceInfo(
  config: MlflowUcConfig,
  semanticRoot: ReadableSpan,
  spans: ReadableSpan[],
): MlflowUcTraceInfo {
  const otelTraceId = semanticRoot.spanContext().traceId;
  const inputs = stringAttribute(semanticRoot.attributes, "mlflow.spanInputs");
  const outputs = stringAttribute(
    semanticRoot.attributes,
    "mlflow.spanOutputs",
  );
  const traceMetadata: Record<string, string> = {
    "mlflow.trace_schema.version": "4",
    [MLFLOW_EXPERIMENT_ID_ATTRIBUTE]: config.experimentId,
  };

  if (inputs !== undefined) traceMetadata["mlflow.traceInputs"] = inputs;
  if (outputs !== undefined) traceMetadata["mlflow.traceOutputs"] = outputs;
  for (const key of TRACE_METADATA_IDENTITIES) {
    const value = stringAttribute(semanticRoot.attributes, key);
    if (value !== undefined) traceMetadata[key] = value;
  }

  const usage = aggregateUsage(semanticRoot, spans);
  if (usage) traceMetadata["mlflow.trace.tokenUsage"] = JSON.stringify(usage);
  const cost = stringAttribute(semanticRoot.attributes, "mlflow.trace.cost");
  if (cost !== undefined) traceMetadata["mlflow.trace.cost"] = cost;

  const requestTimeMs = hrTimeToMilliseconds(semanticRoot.startTime);
  const durationMs = hrTimeToMilliseconds(semanticRoot.duration);
  return {
    trace_id: constructMlflowV4TraceId(config, otelTraceId),
    client_request_id: stringAttribute(
      semanticRoot.attributes,
      "appkit.request.id",
    ),
    trace_location: {
      type: "UC_TABLE_PREFIX",
      uc_table_prefix: {
        catalog_name: config.catalogName,
        schema_name: config.schemaName,
        table_prefix: config.tablePrefix,
        otel_spans_table_name: config.otelSpansTableName,
      },
    },
    request_preview: inputs,
    response_preview: outputs,
    request_time: new Date(requestTimeMs).toISOString(),
    execution_duration: `${durationMs / 1000}s`,
    state: semanticRoot.status.code === SpanStatusCode.ERROR ? "ERROR" : "OK",
    trace_metadata: traceMetadata,
    tags: { "mlflow.traceName": semanticRoot.name },
    assessments: [],
  };
}

function stringAttribute(
  attributes: Attributes,
  key: string,
): string | undefined {
  const value = attributes[key];
  return typeof value === "string" ? value : undefined;
}

function aggregateUsage(
  semanticRoot: ReadableSpan,
  spans: ReadableSpan[],
): Record<string, number> | undefined {
  const rootUsage = parseUsage(
    semanticRoot.attributes["mlflow.trace.tokenUsage"],
  );
  if (rootUsage) return rootUsage;

  const total: Record<string, number> = {};
  let found = false;
  for (const span of spans) {
    const usage = parseUsage(span.attributes["mlflow.chat.tokenUsage"]);
    if (!usage) continue;
    found = true;
    for (const [key, value] of Object.entries(usage)) {
      total[key] = (total[key] ?? 0) + value;
    }
  }
  return found ? total : undefined;
}

function parseUsage(value: unknown): Record<string, number> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const numeric = Object.entries(parsed).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]),
    );
    return numeric.length > 0 ? Object.fromEntries(numeric) : undefined;
  } catch {
    return undefined;
  }
}

function hrTimeToMilliseconds([seconds, nanoseconds]: HrTime): number {
  return seconds * 1000 + nanoseconds / 1_000_000;
}
