{{if .plugins.lakebase -}}
import { context, isSpanContextValid, trace } from '@opentelemetry/api';

export interface LakebaseQueryClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const DEFAULT_SERVICE_NAME = 'databricks-app';
const MAX_SERVICE_NAME_LENGTH = 128;

function serviceNameFromEnvironment(): string {
  return process.env.OTEL_SERVICE_NAME || process.env.DATABRICKS_APP_NAME || DEFAULT_SERVICE_NAME;
}

function safeServiceName(serviceName: string): string {
  const sanitized = serviceName
    .trim()
    .replace(/[^A-Za-z0-9._:/-]/g, '_')
    .slice(0, MAX_SERVICE_NAME_LENGTH);
  return sanitized || DEFAULT_SERVICE_NAME;
}

/**
 * Adds the active OpenTelemetry span context immediately before a query is
 * executed. No span is created here, and no request state is stored on the
 * shared Lakebase pool.
 */
export function withLakebaseTraceContext(
  lakebase: LakebaseQueryClient,
  serviceName = serviceNameFromEnvironment(),
): LakebaseQueryClient {
  const service = safeServiceName(serviceName);

  return {
    query(text, params) {
      const span = trace.getSpan(context.active());
      const spanContext = span?.spanContext();

      if (!spanContext || !isSpanContextValid(spanContext)) {
        return lakebase.query(text, params);
      }

      const flags = (spanContext.traceFlags & 0xff).toString(16).padStart(2, '0');
      const traceparent = `00-${spanContext.traceId.toLowerCase()}-${spanContext.spanId.toLowerCase()}-${flags}`;
      const annotatedSql = `/*traceparent='${traceparent}',service='${service}'*/\n${text}`;

      return lakebase.query(annotatedSql, params);
    },
  };
}
{{- end}}
