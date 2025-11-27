import type { TelemetryOptions } from "@databricks-apps/types";
import type { Meter, Span, SpanOptions, Tracer } from "@opentelemetry/api";
import { metrics, trace } from "@opentelemetry/api";
import { type Logger, type LogRecord, logs } from "@opentelemetry/api-logs";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import {
  normalizeTelemetryOptions,
  type TelemetryProviderConfig,
} from "./config";
import { NOOP_LOGGER, NOOP_METER, NOOP_TRACER } from "./noop";
import type { TelemetryManager } from "./telemetry-manager";
import type { InstrumentConfig, ITelemetry } from "./types";

/**
 * Scoped telemetry instance for specific plugins and other classes.
 * Automatically uses the plugin name as the default tracer/meter name.
 */
export class TelemetryProvider implements ITelemetry {
  private readonly pluginName: string;
  private readonly globalManager: TelemetryManager;
  private readonly config: TelemetryProviderConfig;

  constructor(
    pluginName: string,
    globalManager: TelemetryManager,
    telemetryConfig?: TelemetryOptions,
  ) {
    this.pluginName = pluginName;
    this.globalManager = globalManager;
    this.config = normalizeTelemetryOptions(telemetryConfig);
  }

  /**
   * Gets a tracer for creating spans.
   * @param options - Optional tracer configuration.
   */
  getTracer(options?: InstrumentConfig): Tracer {
    if (!this.config.traces) {
      return NOOP_TRACER;
    }

    const tracerName = this.getInstrumentName(options);
    return trace.getTracer(tracerName);
  }

  /**
   * Gets a meter for recording metrics.
   * @param config - Optional meter configuration.
   */
  getMeter(config?: InstrumentConfig): Meter {
    if (!this.config.metrics) {
      return NOOP_METER;
    }

    const meterName = this.getInstrumentName(config);
    return metrics.getMeter(meterName);
  }

  /**
   * Gets a logger for emitting log records.
   * @param config - Optional logger configuration.
   */
  getLogger(config?: InstrumentConfig): Logger {
    if (!this.config.logs) {
      return NOOP_LOGGER;
    }

    const loggerName = this.getInstrumentName(config);
    return logs.getLogger(loggerName);
  }

  /**
   * Emits a log record using the default logger.
   * Convenience method for logging without explicitly getting a logger.
   * @param logRecord - The log record to emit
   */
  emit(logRecord: LogRecord): void {
    const logger = this.getLogger();
    logger.emit(logRecord);
  }

  /**
   * Register OpenTelemetry instrumentations.
   * Can be called at any time, but recommended to call in plugin constructor.
   * @param instrumentations - Array of OpenTelemetry instrumentations to register
   */
  registerInstrumentations(instrumentations: Instrumentation[]): void {
    if (!this.config.traces) {
      return;
    }

    this.globalManager.registerInstrumentations(instrumentations);
  }

  /**
   * Starts an active span and executes a callback function within its context.
   * Uses the plugin's default tracer unless custom tracer options are provided.
   * @param name - The name of the span
   * @param options - Span options including attributes, kind, etc.
   * @param fn - Callback function to execute within the span context
   * @param tracerOptions - Optional tracer configuration
   * @returns Promise resolving to the callback's return value
   */
  startActiveSpan<T>(
    name: string,
    options: SpanOptions,
    fn: (span: Span) => Promise<T>,
    tracerOptions?: InstrumentConfig,
  ): Promise<T> {
    const tracer = this.getTracer(tracerOptions);
    return tracer.startActiveSpan(name, options, fn);
  }

  private getInstrumentName(options?: InstrumentConfig): string {
    const prefix = this.pluginName;
    if (!options || !options.name) {
      return this.pluginName;
    }

    return options.includePrefix ? `${prefix}-${options.name}` : options.name;
  }
}
