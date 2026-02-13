import type pg from "pg";
import { createLogger } from "./logger";
import type { LakebasePoolConfig } from "./types";

const logger = createLogger("telemetry");

// Dynamic imports for OpenTelemetry - these will be null if @opentelemetry/api is not installed
let otelApi: typeof import("@opentelemetry/api") | null = null;
let otelInitialized = false;

// Try to load OpenTelemetry API at module load time
async function loadOpenTelemetry(): Promise<void> {
  if (otelInitialized) return;
  otelInitialized = true;

  try {
    otelApi = await import("@opentelemetry/api");
    logger.debug("OpenTelemetry API loaded successfully");
  } catch {
    // OpenTelemetry not installed - telemetry will be no-op
    logger.debug("OpenTelemetry API not available - telemetry disabled");
  }
}

// Eagerly load OpenTelemetry (non-blocking)
loadOpenTelemetry().catch(() => {
  // Ignore errors - just means telemetry won't be available
});

/** Telemetry provider interface */
export interface TelemetryProvider {
  getTracer(): Tracer;
  getMeter(): Meter;
  startActiveSpan<T>(
    name: string,
    options: SpanOptions,
    fn: (span: Span) => Promise<T>,
  ): Promise<T>;
}

/** OpenTelemetry Tracer interface */
export interface Tracer {
  startActiveSpan<T>(
    name: string,
    options: SpanOptions,
    fn: (span: Span) => T,
  ): T;
}

/** OpenTelemetry Meter interface */
export interface Meter {
  createHistogram(name: string, options?: MetricOptions): Histogram;
  createCounter(name: string, options?: MetricOptions): Counter;
  createObservableGauge(name: string, options?: MetricOptions): ObservableGauge;
}

/** OpenTelemetry Span interface */
export interface Span {
  setAttribute(key: string, value: string | number): void;
  setStatus(status: { code: number }): void;
  recordException(error: Error): void;
  end(): void;
}

/** OpenTelemetry Histogram interface */
export interface Histogram {
  record(value: number, attributes?: Record<string, string>): void;
}

/** OpenTelemetry Counter interface */
export interface Counter {
  add(value: number, attributes?: Record<string, string>): void;
}

/** OpenTelemetry ObservableGauge interface */
export interface ObservableGauge {
  addCallback(callback: (result: ObservableResult) => void): void;
}

/** OpenTelemetry ObservableResult interface */
export interface ObservableResult {
  observe(value: number): void;
}

/** Span options */
export interface SpanOptions {
  kind?: number;
  attributes?: Record<string, string | number>;
}

/** Metric options */
export interface MetricOptions {
  description?: string;
  unit?: string;
}

/** Span status codes */
export const SpanStatusCode = {
  OK: 1,
  ERROR: 2,
};

/** Span kinds */
export const SpanKind = {
  CLIENT: 3,
};

/** Telemetry instruments for the driver */
export interface DriverTelemetry {
  provider: TelemetryProvider;
  tokenRefreshDuration: Histogram;
  queryDuration: Histogram;
  poolErrors: Counter;
}

/** No-op implementations for when OpenTelemetry is not available */
const noopSpan: Span = {
  setAttribute: () => {},
  setStatus: () => {},
  recordException: () => {},
  end: () => {},
};

const noopHistogram: Histogram = {
  record: () => {},
};

const noopCounter: Counter = {
  add: () => {},
};

const noopObservableGauge: ObservableGauge = {
  addCallback: () => {},
};

const noopTracer: Tracer = {
  startActiveSpan: <T>(
    _name: string,
    _options: SpanOptions,
    fn: (span: Span) => T,
  ): T => {
    return fn(noopSpan);
  },
};

const noopMeter: Meter = {
  createHistogram: () => noopHistogram,
  createCounter: () => noopCounter,
  createObservableGauge: () => noopObservableGauge,
};

const noopProvider: TelemetryProvider = {
  getTracer: () => noopTracer,
  getMeter: () => noopMeter,
  startActiveSpan: async <T>(
    _name: string,
    _options: SpanOptions,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> => {
    return fn(noopSpan);
  },
};

/** Create a real telemetry provider using OpenTelemetry API */
function createRealProvider(): TelemetryProvider {
  if (!otelApi) {
    return noopProvider;
  }

  const tracer = otelApi.trace.getTracer("@databricks/lakebase");
  const meter = otelApi.metrics.getMeter("@databricks/lakebase");

  return {
    getTracer: () => ({
      startActiveSpan: <T>(
        name: string,
        options: SpanOptions,
        fn: (span: Span) => T,
      ): T => {
        return tracer.startActiveSpan(name, options as any, fn as any);
      },
    }),
    getMeter: () => ({
      createHistogram: (name: string, options?: MetricOptions) => {
        return meter.createHistogram(name, options as any);
      },
      createCounter: (name: string, options?: MetricOptions) => {
        return meter.createCounter(name, options as any);
      },
      createObservableGauge: (name: string, options?: MetricOptions) => {
        return meter.createObservableGauge(name, options as any);
      },
    }),
    startActiveSpan: async <T>(
      name: string,
      options: SpanOptions,
      fn: (span: Span) => Promise<T>,
    ): Promise<T> => {
      return tracer.startActiveSpan(name, options as any, fn as any);
    },
  };
}

/** Initialize telemetry provider and create metric instruments */
export function initTelemetry(
  config: Partial<LakebasePoolConfig>,
): DriverTelemetry {
  // Check if telemetry is explicitly disabled
  if (config.telemetry === false) {
    return {
      provider: noopProvider,
      tokenRefreshDuration: noopHistogram,
      queryDuration: noopHistogram,
      poolErrors: noopCounter,
    };
  }

  const provider = createRealProvider();
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
 * Uses observable gauges (pull model) for pool connection stats.
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
