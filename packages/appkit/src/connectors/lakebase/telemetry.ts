import type pg from "pg";
import {
  type Counter,
  type Histogram,
  TelemetryManager,
  type TelemetryProvider,
} from "@/telemetry";
import { createLogger } from "../../logging/logger";
import type { LakebasePoolConfig } from "./types";

const logger = createLogger("connectors:lakebase:pool");

/** Telemetry instruments shared across the driver */
export interface DriverTelemetry {
  provider: TelemetryProvider;
  tokenRefreshDuration: Histogram;
  queryDuration: Histogram;
  poolErrors: Counter;
}

/** Create telemetry provider and metric instruments */
export function initTelemetry(
  config: Partial<LakebasePoolConfig>,
): DriverTelemetry {
  const provider = TelemetryManager.getProvider(
    "connectors:lakebase",
    config.telemetry,
  );
  const meter = provider.getMeter();

  return {
    provider,
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
 * Uses observable gauges (pull model) for pool connection stats -- the OTEL SDK
 * reads pool counts at collection time, requiring no timers or cleanup.
 */
export function attachPoolMetrics(
  pool: pg.Pool,
  telemetry: DriverTelemetry,
): void {
  const meter = telemetry.provider.getMeter();

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

  // Single error handler for both logging and metrics
  pool.on("error", (error: Error & { code?: string }) => {
    logger.error(
      "Connection pool error: %s (code: %s)",
      error.message,
      error.code,
    );
    telemetry.poolErrors.add(1, {
      "error.code": error.code ?? "unknown",
    });
  });
}
