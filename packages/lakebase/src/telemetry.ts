import type { Counter, Histogram, Meter } from "@opentelemetry/api";
import {
  metrics,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import type pg from "pg";
import type { Logger } from "./types";

export { SpanKind, SpanStatusCode };
export type { Tracer };

/** Telemetry instruments for the driver */
export interface DriverTelemetry {
  tracer: Tracer;
  meter: Meter;
  tokenRefreshDuration: Histogram;
  queryDuration: Histogram;
  poolErrors: Counter;
}

/**
 * Initialize telemetry using OpenTelemetry's global registry.
 * If Otel providers are not initialized, operations will be no-ops automatically.
 */
export function initTelemetry(): DriverTelemetry {
  const tracer = trace.getTracer("@databricks/lakebase");
  const meter = metrics.getMeter("@databricks/lakebase");

  return {
    tracer,
    meter,
    tokenRefreshDuration: meter.createHistogram(
      "lakebase.token.refresh.duration",
      {
        description: "Duration of OAuth token refresh operations",
        unit: "ms",
      },
    ),
    queryDuration: meter.createHistogram("lakebase.query.duration", {
      description: "Duration of queries executed via pool.query",
      unit: "ms",
    }),
    poolErrors: meter.createCounter("lakebase.pool.errors", {
      description: "Connection pool errors by error code",
      unit: "1",
    }),
  };
}

/**
 * Attach pool-level metrics collection, error counting, and error logging.
 *
 * Uses observable gauges (pull model) for pool connection stats.
 *
 * @param pool - PostgreSQL connection pool
 * @param telemetry - Telemetry instruments
 * @param logger - Optional logger for error logging (silent if not provided)
 */
export function attachPoolMetrics(
  pool: pg.Pool,
  telemetry: DriverTelemetry,
  logger?: Logger,
): void {
  const meter = telemetry.meter;

  const poolTotal = meter.createObservableGauge(
    "lakebase.pool.connections.total",
    { description: "Total connections in the pool" },
  );
  const poolIdle = meter.createObservableGauge(
    "lakebase.pool.connections.idle",
    { description: "Idle connections in the pool" },
  );
  const poolWaiting = meter.createObservableGauge(
    "lakebase.pool.connections.waiting",
    { description: "Clients waiting for a connection" },
  );

  poolTotal.addCallback((result) => result.observe(pool.totalCount));
  poolIdle.addCallback((result) => result.observe(pool.idleCount));
  poolWaiting.addCallback((result) => result.observe(pool.waitingCount));

  pool.on("error", (error: Error & { code?: string }) => {
    logger?.error(
      "Connection pool error: %s (code: %s)",
      error.message,
      error.code,
    );
    telemetry.poolErrors.add(1, {
      "error.code": error.code ?? "unknown",
    });
  });
}
