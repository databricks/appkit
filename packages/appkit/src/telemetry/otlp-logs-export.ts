import { parseKeyPairsIntoRecord } from "@opentelemetry/core";

/** Where OTLP/HTTP log records are sent, as configured by the environment. */
export interface OtlpLogsExport {
  /** Full logs endpoint URL. */
  url: string;
  /** Headers every export request carries, for example collector credentials. */
  headers: Record<string, string>;
}

/**
 * Resolve the OTLP/HTTP logs destination from the standard OpenTelemetry
 * environment variables, as the OTLP exporters do:
 *
 * - `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is used as-is; otherwise `/v1/logs` is
 *   appended to `OTEL_EXPORTER_OTLP_ENDPOINT`.
 * - Headers come from `OTEL_EXPORTER_OTLP_HEADERS`, with
 *   `OTEL_EXPORTER_OTLP_LOGS_HEADERS` taking precedence per key. Both use the
 *   `key1=value1,key2=value2` format, with percent-encoded values.
 *
 * Databricks Apps sets the endpoint only when App telemetry is enabled, so
 * `undefined` means there is no collector to send to.
 */
export function resolveOtlpLogsExport(
  env: NodeJS.ProcessEnv = process.env,
): OtlpLogsExport | undefined {
  const url = resolveUrl(env);
  if (url === undefined) return undefined;

  return {
    url,
    headers: {
      ...parseKeyPairsIntoRecord(env.OTEL_EXPORTER_OTLP_HEADERS),
      ...parseKeyPairsIntoRecord(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS),
    },
  };
}

function resolveUrl(env: NodeJS.ProcessEnv): string | undefined {
  const logsEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (logsEndpoint) return logsEndpoint;

  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!baseEndpoint) return undefined;

  return `${baseEndpoint.replace(/\/$/, "")}/v1/logs`;
}
