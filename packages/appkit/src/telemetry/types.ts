import type { Meter, Span, SpanOptions, Tracer } from "@opentelemetry/api";
import type { Logger, LogRecord } from "@opentelemetry/api-logs";
import type { Instrumentation } from "@opentelemetry/instrumentation";

/** OpenTelemetry configuration for AppKit applications */
export interface TelemetryConfig {
  serviceName?: string;
  serviceVersion?: string;
  instrumentations?: Instrumentation[];
  exportIntervalMs?: number;
  headers?: Record<string, string>;
}

/**
 * Instrument customization options.
 */
export interface InstrumentConfig {
  /**
   * The name of the instrument.
   */
  name?: string;
  /**
   * If true, the prefix from the context (e.g. plugin name) will be kept when constructing the final instrument name.
   * For example, if the plugin name is "my-plugin" and the instrument name is "my-instrument", the final instrument name will be "my-plugin-my-instrument".
   * If false, the final instrument name will be "my-instrument".
   */
  includePrefix?: boolean;
}

/**
 * Plugin-facing interface for OpenTelemetry instrumentation.
 * Provides a thin abstraction over OpenTelemetry APIs for plugins.
 */
export interface ITelemetry {
  /**
   * Gets a tracer for creating spans.
   * @param options - Instrument customization options.
   */
  getTracer(options?: InstrumentConfig): Tracer;

  /**
   * Gets a meter for recording metrics.
   * @param options - Instrument customization options.
   */
  getMeter(options?: InstrumentConfig): Meter;

  /**
   * Gets a logger for emitting log records.
   * @param options - Instrument customization options.
   */
  getLogger(options?: InstrumentConfig): Logger;

  /**
   * Emits a log record using the default logger.
   * Respects the logs enabled/disabled config.
   * @param logRecord - The log record to emit
   */
  emit(logRecord: LogRecord): void;

  /**
   * Starts an active span and executes a callback function within its context.
   * Respects the traces enabled/disabled config.
   * When traces are disabled, executes the callback with a no-op span.
   * @param name - The name of the span
   * @param options - Span options including attributes, kind, etc.
   * @param fn - Callback function to execute within the span context
   * @param tracerOptions - Optional tracer configuration (custom name, prefix inclusion)
   * @returns Promise resolving to the callback's return value
   */
  startActiveSpan<T>(
    name: string,
    options: SpanOptions,
    fn: (span: Span) => Promise<T>,
    tracerOptions?: InstrumentConfig,
  ): Promise<T>;

  /**
   * Register OpenTelemetry instrumentations.
   * Can be called at any time, but recommended to call in plugin constructor.
   * @param instrumentations - Array of OpenTelemetry instrumentations to register
   */
  registerInstrumentations(instrumentations: Instrumentation[]): void;
}
