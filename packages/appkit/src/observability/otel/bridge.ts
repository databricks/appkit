import {
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  metrics,
  type Span,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { type Logger, logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  detectResources,
  envDetector,
  hostDetector,
  processDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { createDebug } from "../debug";
import {
  expressInstrumentation,
  httpInstrumentation,
} from "../instrumentations";
import type {
  MetricOptions,
  ObservabilityConfig,
  ObservabilityOptions,
} from "../types";
import { NOOP_COUNTER, NOOP_HISTOGRAM, NOOP_SPAN } from "./noop";

const debug = createDebug("otel");

/**
 * OTEL Bridge
 * - Responsible for initializing the OpenTelemetry SDK and creating scoped bridges
 */
export class OTELBridge {
  private sdk?: NodeSDK;
  private enabled: boolean;
  private config: ObservabilityConfig;

  constructor(config: ObservabilityConfig = {}) {
    this.config = config;
    this.enabled =
      config.enabled !== false && !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (this.enabled) {
      this.initializeSdk();
    } else {
      debug("OTEL disabled (no OTEL_EXPORTER_OTLP_ENDPOINT)");
    }
  }

  /**
   * Initialize the OpenTelemetry SDK
   */
  private initializeSdk(): void {
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT!;
    const serviceName =
      this.config.serviceName ||
      process.env.OTEL_SERVICE_NAME ||
      process.env.DATABRICKS_APP_NAME ||
      "databricks-app";

    // Respect config flags (default to true if not specified)
    const tracesEnabled = this.config.traces !== false;
    const metricsEnabled = this.config.metrics !== false;
    const logsEnabled = this.config.logs !== false;

    debug("Initializing OTEL SDK", {
      endpoint,
      serviceName,
      traces: tracesEnabled,
      metrics: metricsEnabled,
      logs: logsEnabled,
    });

    // create resource with service attributes and detected resources
    const initialResource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: this.config.serviceVersion || "unknown",
    });
    const detectedResource = detectResources({
      detectors: [envDetector, hostDetector, processDetector],
    });
    const resource = initialResource.merge(detectedResource);

    // Build SDK config conditionally based on flags
    const sdkConfig: ConstructorParameters<typeof NodeSDK>[0] = {
      resource,
      autoDetectResources: false,
      instrumentations: tracesEnabled
        ? [httpInstrumentation, expressInstrumentation]
        : [],
    };

    if (tracesEnabled) {
      sdkConfig.traceExporter = new OTLPTraceExporter({
        url: `${endpoint}/v1/traces`,
        headers: this.config.headers,
      });
    }

    if (metricsEnabled) {
      sdkConfig.metricReader = new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${endpoint}/v1/metrics`,
          headers: this.config.headers,
        }),
        exportIntervalMillis: this.config.exportIntervalMs || 10000,
      });
    }

    if (logsEnabled) {
      sdkConfig.logRecordProcessor = new BatchLogRecordProcessor(
        new OTLPLogExporter({
          url: `${endpoint}/v1/logs`,
          headers: this.config.headers,
        }),
      );
    }

    this.sdk = new NodeSDK(sdkConfig);

    this.sdk.start();
    debug("OTEL SDK started");
  }

  /**
   * Create a scoped OTEL bridge
   * @param scope - The scope of the bridge
   * @param config - The configuration for the bridge
   * @returns The scoped OTEL bridge
   */
  createScoped(scope: string, config?: ObservabilityOptions): ScopedOTELBridge {
    return new ScopedOTELBridge(scope, this, config);
  }

  /**
   * Get a tracer for the given name
   * @param name - The name of the tracer
   * @returns The tracer
   */
  getTracer(name: string): Tracer {
    return trace.getTracer(name);
  }

  /**
   * Get a meter for the given name
   * @param name - The name of the meter
   * @returns The meter
   */
  getMeter(name: string): Meter {
    return metrics.getMeter(name);
  }

  /**
   * Get a logger for the given name
   * @param name - The name of the logger
   * @returns The logger
   */
  getLogger(name: string): Logger {
    return logs.getLogger(name);
  }

  /**
   * Check if OTEL is enabled
   * @returns True if OTEL is enabled, false otherwise
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Register OpenTelemetry instrumentations.
   * Note: This is currently a no-op as instrumentations are registered during SDK initialization.
   * @param instrumentations - Array of OpenTelemetry instrumentations to register
   */
  registerInstrumentations(instrumentations: unknown[]): void {
    debug("Registering instrumentations", { count: instrumentations.length });
  }

  /**
   * Shutdown the OpenTelemetry SDK
   */
  async shutdown(): Promise<void> {
    if (this.sdk) {
      debug("Shutting down OTEL SDK");
      await this.sdk.shutdown();
    }
  }
}

/**
 * Scoped OTEL Bridge
 */
export class ScopedOTELBridge {
  private scope: string;
  private bridge: OTELBridge;
  private tracesEnabled: boolean;
  private metricsEnabled: boolean;
  private logsEnabled: boolean;

  constructor(
    scope: string,
    bridge: OTELBridge,
    config?: ObservabilityOptions,
  ) {
    this.scope = scope;
    this.bridge = bridge;

    // normalize config
    if (typeof config === "boolean") {
      this.tracesEnabled = config && bridge.isEnabled();
      this.metricsEnabled = config && bridge.isEnabled();
      this.logsEnabled = config && bridge.isEnabled();
    } else {
      this.tracesEnabled = (config?.traces ?? true) && bridge.isEnabled();
      this.metricsEnabled = (config?.metrics ?? true) && bridge.isEnabled();
      this.logsEnabled = (config?.logs ?? true) && bridge.isEnabled();
    }
  }

  /**
   * Start an active span
   * @param name - The name of the span
   * @param attributes - The attributes for the span
   * @param fn - The function to execute within the span
   * @returns The result of the function
   */
  async startActiveSpan<T>(
    name: string,
    attributes: Attributes,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    if (!this.tracesEnabled) {
      return fn(NOOP_SPAN);
    }

    const tracer = this.bridge.getTracer(this.scope);
    return tracer.startActiveSpan(name, { attributes }, (span) => {
      return fn(span)
        .then((result) => {
          span.end();
          return result;
        })
        .catch((error) => {
          span.end();
          throw error;
        });
    });
  }

  /**
   * Get a meter for the given name
   * @param name - The name of the meter
   * @returns The meter
   */
  getMeter(name: string): Meter {
    return this.bridge.getMeter(name);
  }
  /**
   * Get a logger for the given name
   * @param name - The name of the logger
   * @returns The logger
   */
  getLogger(name: string): Logger {
    return this.bridge.getLogger(name);
  }

  /**
   * Emit a log
   * @param level - The level of the log
   * @param message - The message of the log
   * @param context - The context of the log
   */
  emitLog(
    level: string,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    if (!this.logsEnabled) return;

    const logger = this.bridge.getLogger(this.scope);

    // Convert context to OTEL Attributes (only primitives allowed)
    const attributes: Attributes = {};
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          attributes[key] = value;
        } else if (value !== null && value !== undefined) {
          // Stringify complex values
          attributes[key] = JSON.stringify(value);
        }
      }
    }

    logger.emit({
      body: message,
      severityNumber: this.levelToSeverity(level),
      attributes,
    });
  }

  /**
   * Create a counter
   * @param name - The name of the counter
   * @param options - The options for the counter
   * @returns The counter
   */
  createCounter(name: string, options?: MetricOptions): Counter {
    if (!this.metricsEnabled) return NOOP_COUNTER;

    return this.bridge.getMeter(this.scope).createCounter(name, {
      unit: options?.unit,
      description: options?.description,
    });
  }

  /**
   * Create a histogram
   * @param name - The name of the histogram
   * @param options - The options for the histogram
   * @returns The histogram
   */
  createHistogram(name: string, options?: MetricOptions): Histogram {
    if (!this.metricsEnabled) return NOOP_HISTOGRAM;

    return this.bridge.getMeter(this.scope).createHistogram(name, {
      unit: options?.unit,
      description: options?.description,
    });
  }

  /**
   * Create a scoped OTEL bridge
   * @param childScope - The child scope of the bridge
   * @returns The scoped OTEL bridge
   */
  createScoped(childScope: string): ScopedOTELBridge {
    return new ScopedOTELBridge(`${this.scope}.${childScope}`, this.bridge, {
      traces: this.tracesEnabled,
      metrics: this.metricsEnabled,
      logs: this.logsEnabled,
    });
  }

  /**
   * Convert a log level to a severity number
   * @param level - The level of the log
   * @returns The severity number
   */
  private levelToSeverity(level: string): SeverityNumber {
    switch (level) {
      case "debug":
        return SeverityNumber.DEBUG;
      case "info":
        return SeverityNumber.INFO;
      case "warn":
        return SeverityNumber.WARN;
      case "error":
        return SeverityNumber.ERROR;
      default:
        return SeverityNumber.INFO;
    }
  }
}
