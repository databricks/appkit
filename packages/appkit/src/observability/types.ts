import type { Counter, Histogram, Span } from "@opentelemetry/api";
import type { WideEvent } from "./wide-event";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** * Log context for structured logging */
export interface LogContext {
  [key: string]: unknown;
}

/** * Span options for tracing */
export interface SpanOptions {
  attributes?: Record<string, string | number | boolean>;
}

/** * Metric options for metrics */
export interface MetricOptions {
  unit?: string;
  description?: string;
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Options for error logging
 */
export interface ErrorLogOptions {
  /**
   * Whether to record the error on the current span.
   * When true (default), the error is recorded as an exception on the active span.
   * Set to false for expected errors that shouldn't mark the span as failed.
   * @default true
   */
  recordOnSpan?: boolean;
}

/**
 * Main logger interface for observability in AppKit.
 * Provides unified access to logging, tracing, and metrics.
 *
 * THREE LAYERS OF CONTROL:
 *
 * LAYER 1: Magic (99% of cases) - Automatic observability
 * - logger.debug()  - Terminal only (requires DEBUG=appkit:*)
 * - logger.trace()  - Terminal + WideEvent + individual OTEL log records
 * - logger.info()   - Terminal + WideEvent + Span events
 * - logger.warn()   - Terminal + WideEvent + Span events
 * - logger.error()  - Terminal + WideEvent + Span events + Exception recording
 *
 * Note: WideEvent is sent to OTEL Logs as ONE aggregated record at request end
 *
 * LAYER 2: Opinionated API (when you need control)
 * - logger.span()          - Create traced span (auto-managed)
 * - logger.counter()       - Create counter metric
 * - logger.histogram()     - Create histogram metric
 * - logger.recordContext() - Record context without log entry
 * - logger.child()         - Create child logger with nested scope
 * - logger.getEvent()      - Access WideEvent for advanced use
 *
 * LAYER 3: Escape Hatch (full OTEL power)
 * - otel.getTracer()  - Raw OTEL tracer (custom span names, full control)
 * - otel.getMeter()   - Raw OTEL meter (gauges, observable instruments)
 * - otel.getLogger()  - Raw OTEL logger (rarely needed)
 *
 * OBSERVABILITY FLOW:
 * 1. During Request: Logs accumulate in WideEvent (in-memory)
 * 2. At Request End: WideEvent sent to OTEL Logs as ONE aggregated record
 * 3. Result: One OTEL log per request (not per logger call)
 *
 * This means:
 * - In Loki/OTEL backend: You see ONE log record per request (the WideEvent)
 * - In Tempo traces: You see individual log events attached to spans
 * - In Terminal: You see individual debug output (requires DEBUG=appkit:*)
 *
 * @example Magic layer - automatic observability
 * ```typescript
 * logger.info("Processing request", { userId: "123" });
 * // ✅ Goes to: Terminal + WideEvent.logs[] + Current Span Events
 * // At request end: WideEvent → OTEL Logs (aggregated)
 * ```
 *
 * @example Opinionated layer - custom spans
 * ```typescript
 * await logger.span("fetch-data", async (span) => {
 *   span.setAttribute("db.system", "databricks");
 *   return await fetchData();
 * }); // ✅ Span auto-ended, status auto-set
 * ```
 *
 * @example Escape hatch - full control
 * ```typescript
 * const tracer = otel.getTracer("custom-name");
 * await tracer.startActiveSpan("operation", async (span) => {
 *   span.setStatus({ code: SpanStatusCode.UNSET });
 *   span.end(); // ⚠️ You manage everything
 * });
 * ```
 */
export interface ILogger {
  /**
   * Log a debug message. Only shows when DEBUG=appkit:* is set.
   * Output: Terminal only (not sent to OTEL or WideEvent).
   * Use this for local development debugging.
   * @param message - The message to log
   * @param context - Optional structured context data
   */
  debug(message: string, context?: LogContext): void;

  /**
   * Log a trace message for detailed debugging.
   * Output: Terminal + WideEvent + individual OTEL log record.
   * Use this for verbose debugging that you want in production observability.
   * Unlike info/warn/error, each trace() creates an individual OTEL log record.
   * @param message - The message to log
   * @param context - Optional structured context data
   */
  trace(message: string, context?: LogContext): void;

  /**
   * Log an info message. Automatically added to WideEvent and current span.
   * Output: Terminal + WideEvent.logs[] + Current Span events.
   * Note: Individual logs are aggregated in WideEvent, which is sent to OTEL Logs at request end.
   * @param message - The message to log
   * @param context - Optional structured context data
   */
  info(message: string, context?: LogContext): void;

  /**
   * Log a warning message. Automatically added to WideEvent and current span.
   * Output: Terminal + WideEvent.logs[] + Current Span events.
   * @param message - The message to log
   * @param context - Optional structured context data
   */
  warn(message: string, context?: LogContext): void;

  /**
   * Log an error message. Automatically added to WideEvent and current span.
   * Output: Terminal + WideEvent.logs[] + Span events.
   * By default, records the exception on the active span.
   * @param message - The message to log
   * @param error - Optional Error object to record
   * @param context - Optional structured context data
   * @param options - Optional error logging configuration
   * @example Expected error (don't fail span)
   * ```typescript
   * logger.error("Cache miss", error, context, { recordOnSpan: false });
   * ```
   * @example Unexpected error (default - fails span)
   * ```typescript
   * logger.error("Database connection failed", error);
   * ```
   */
  error(
    message: string,
    error?: Error,
    context?: LogContext,
    options?: ErrorLogOptions,
  ): void;

  /**
   * Execute a function within a traced span. Span is automatically ended.
   * @param name - The span name (will be scoped to logger name)
   * @param fn - The async function to execute within the span
   * @param options - Optional span configuration
   * @returns Promise resolving to the function's return value
   */
  span<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options?: SpanOptions,
  ): Promise<T>;

  /**
   * Create a counter metric.
   * @param name - The metric name (will be scoped to logger name)
   * @param options - Optional metric configuration
   * @returns A Counter instance for recording values
   */
  counter(name: string, options?: MetricOptions): Counter;

  /**
   * Create a histogram metric.
   * @param name - The metric name (will be scoped to logger name)
   * @param options - Optional metric configuration
   * @returns A Histogram instance for recording values
   */
  histogram(name: string, options?: MetricOptions): Histogram;

  /**
   * Record context to WideEvent and current span without generating a log entry.
   * Use this to enrich the request context with metadata without cluttering logs.
   * @param context - Context data to record
   * @example
   * ```typescript
   * // Record metadata without creating a log entry
   * logger.recordContext({ warehouseId: "wh-123", userId: "user-456" });
   * ```
   */
  recordContext(context: LogContext): void;

  /**
   * Get the current WideEvent if in request context (advanced usage).
   * @returns The current WideEvent or undefined if outside request context
   */
  getEvent(): WideEvent | undefined;

  /**
   * Create a child logger with additional scope.
   * @param scope - The additional scope name to append
   * @returns A new ILogger instance with the combined scope
   */
  child(scope: string): ILogger;
}

/**
 * App-level observability configuration
 */
export interface ObservabilityConfig {
  // enable/disable all observability (default: true)
  enabled?: boolean;

  // service name for telemetry (default: DATABRICKS_APP_NAME)
  serviceName?: string;

  // service version for telemetry
  serviceVersion?: string;

  // enable traces export to OTLP (default: true if endpoint configured)
  traces?: boolean;

  // enable metrics export to OTLP (default: true if endpoint configured)
  metrics?: boolean;

  // enable logs export to OTLP (default: true if endpoint configured)
  logs?: boolean;

  // custom OTLP headers
  headers?: Record<string, string>;

  // metric export interval in ms (default: 10000)
  exportIntervalMs?: number;
}

export type { ObservabilityOptions } from "shared";
