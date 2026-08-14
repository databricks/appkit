import { metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  type Instrumentation,
  registerInstrumentations as otelRegisterInstrumentations,
} from "@opentelemetry/instrumentation";
import {
  detectResources,
  envDetector,
  hostDetector,
  processDetector,
  type Resource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import type { TelemetryOptions } from "shared";

import { createLogger } from "../logging/logger";
import { TelemetryProvider } from "./telemetry-provider";
import { AppKitSampler } from "./trace-sampler";
import type { TelemetryConfig } from "./types";

const logger = createLogger("telemetry");

/**
 * Owns the app's OpenTelemetry providers, split into two phases so plugins can
 * contribute trace span processors before the tracer provider is built.
 *
 * - `initialize()` runs at app bootstrap, before plugin setup. It registers the
 *   meter and logger providers eagerly, because OTel's metrics API has no lazy
 *   proxy: a counter/histogram bound against the NoOp meter (as every connector
 *   and the cache do in their constructors) stays NoOp for the process lifetime.
 *   It does NOT register a tracer provider.
 * - `registerSpanProcessor()` is called by plugins during `setup()` to add a
 *   span processor (e.g. an MLflow exporter) to the not-yet-built tracer.
 * - `start()` runs after all plugin `setup()` completes. It builds the single
 *   global tracer provider with the OTLP processor (if configured) plus every
 *   contributed processor. Deferring is safe for traces: OTel's ProxyTracer
 *   rebinds tracers obtained before registration, and no span is emitted during
 *   setup.
 */
export class TelemetryManager {
  private static readonly DEFAULT_EXPORT_INTERVAL_MS = 10000;
  private static readonly DEFAULT_FALLBACK_APP_NAME = "databricks-app";

  private static instance?: TelemetryManager;
  private resource?: Resource;
  private meterProvider?: MeterProvider;
  private loggerProvider?: LoggerProvider;
  private tracerProvider?: NodeTracerProvider;
  private readonly spanProcessors: SpanProcessor[] = [];
  private started = false;
  private shutdownPromise?: Promise<void>;

  /**
   * Create a scoped telemetry provider for a specific plugin.
   * The plugin's name will be used as the default tracer/meter name.
   * @param pluginName - The name of the plugin to create scoped telemetry for
   * @param telemetryConfig - The telemetry configuration for the plugin
   * @returns A scoped telemetry instance for the plugin
   */
  static getProvider(
    pluginName: string,
    telemetryConfig?: TelemetryOptions,
  ): TelemetryProvider {
    const globalManager = TelemetryManager.getInstance();
    return new TelemetryProvider(pluginName, globalManager, telemetryConfig);
  }

  private constructor() {}

  static getInstance(): TelemetryManager {
    if (!TelemetryManager.instance) {
      TelemetryManager.instance = new TelemetryManager();
    }
    return TelemetryManager.instance;
  }

  static initialize(config: Partial<TelemetryConfig> = {}): void {
    const instance = TelemetryManager.getInstance();
    instance._initialize(config);
  }

  /**
   * Contribute a span processor to the not-yet-built tracer provider. Called by
   * plugins during `setup()`. No-op with a warning once `start()` has run, since
   * a started provider's processors are immutable in OTel JS 2.x.
   */
  static registerSpanProcessor(processor: SpanProcessor): void {
    TelemetryManager.getInstance()._registerSpanProcessor(processor);
  }

  private _registerSpanProcessor(processor: SpanProcessor): void {
    if (this.started) {
      logger.warn(
        "registerSpanProcessor called after start(); processor ignored. " +
          "Contribute span processors during plugin setup().",
      );
      return;
    }
    this.spanProcessors.push(processor);
  }

  /**
   * Phase 1: register the meter and logger providers eagerly (before plugin
   * setup), so metric instruments bound in connector/cache constructors attach
   * to real meters. The tracer provider is deferred to `start()`.
   *
   * When no OTLP endpoint is configured, meter/logger registration is skipped;
   * a contributed span processor can still bring up tracing in `start()`.
   */
  private _initialize(config: Partial<TelemetryConfig>): void {
    if (this.resource) return;
    this.resource = this.createResource(config);

    // OTLP exporters need an endpoint. Without one there is nothing to export
    // metrics/logs to, so skip those providers — but still capture the resource
    // and let `start()` bring up a tracer if a plugin contributed a processor.
    if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      return;
    }

    try {
      this.meterProvider = new MeterProvider({
        resource: this.resource,
        readers: [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ headers: config.headers }),
            exportIntervalMillis:
              config.exportIntervalMs ||
              TelemetryManager.DEFAULT_EXPORT_INTERVAL_MS,
          }),
        ],
      });
      metrics.setGlobalMeterProvider(this.meterProvider);

      this.loggerProvider = new LoggerProvider({
        resource: this.resource,
        processors: [
          new BatchLogRecordProcessor(
            new OTLPLogExporter({ headers: config.headers }),
          ),
        ],
      });
      logs.setGlobalLoggerProvider(this.loggerProvider);

      // The OTLP trace exporter is the first span processor; contributed
      // processors join it in `start()`.
      this.spanProcessors.push(
        new BatchSpanProcessor(
          new OTLPTraceExporter({ headers: config.headers }),
        ),
      );

      this.registerInstrumentations(this.getDefaultInstrumentations());
      logger.debug("Meter/logger providers initialized");
    } catch (error) {
      logger.error("Failed to initialize: %O", error);
    }
  }

  /**
   * Phase 2: build and register the global tracer provider. Called by core
   * after every plugin's `setup()` completes, so all contributed span
   * processors are known. No-op when nothing needs tracing (no OTLP endpoint
   * and no contributed processor), preserving "no telemetry unless configured".
   *
   * `NodeTracerProvider.register()` installs the async-hooks context manager and
   * W3C propagators — the same wiring `NodeSDK.start()` did — so span nesting
   * across awaits is preserved.
   */
  static start(): void {
    TelemetryManager.getInstance()._start();
  }

  private _start(): void {
    if (this.started) return;
    this.started = true;

    if (this.spanProcessors.length === 0) {
      return;
    }

    try {
      this.tracerProvider = new NodeTracerProvider({
        resource: this.resource,
        sampler: new AppKitSampler(),
        spanProcessors: this.spanProcessors,
      });
      this.tracerProvider.register();
      logger.debug(
        "Tracer provider started with %d span processor(s)",
        this.spanProcessors.length,
      );
    } catch (error) {
      logger.error("Failed to start tracer provider: %O", error);
    }
  }

  /**
   * Register OpenTelemetry instrumentations.
   * Can be called at any time, but recommended to call in plugin constructor.
   * @param instrumentations - Array of OpenTelemetry instrumentations to register
   */
  registerInstrumentations(instrumentations: Instrumentation[]): void {
    otelRegisterInstrumentations({
      //  global providers set by NodeSDK.start()
      instrumentations,
    });
  }

  private createResource(config: Partial<TelemetryConfig>): Resource {
    const serviceName =
      config.serviceName ||
      process.env.OTEL_SERVICE_NAME ||
      process.env.DATABRICKS_APP_NAME ||
      TelemetryManager.DEFAULT_FALLBACK_APP_NAME;
    const initialResource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: config.serviceVersion ?? undefined,
    });
    const detectedResource = detectResources({
      detectors: [envDetector, hostDetector, processDetector],
    });
    return initialResource.merge(detectedResource);
  }

  private getDefaultInstrumentations(): Instrumentation[] {
    return [
      ...getNodeAutoInstrumentations({
        //
        // enabled as a part of the server plugin
        //
        "@opentelemetry/instrumentation-http": {
          enabled: false,
        },
        "@opentelemetry/instrumentation-express": {
          enabled: false,
        },
        //
        // reduce noise
        //
        "@opentelemetry/instrumentation-fs": {
          enabled: false,
        },
        "@opentelemetry/instrumentation-dns": {
          enabled: false,
        },
        "@opentelemetry/instrumentation-net": {
          enabled: false,
        },
      }),
    ];
  }

  /**
   * Flush and shut down the tracer, meter, and logger providers.
   *
   * Idempotent: the provider references are cleared synchronously and concurrent
   * or repeated calls await the same in-flight flush. Awaited by the core
   * lifecycle manager during graceful shutdown — that manager owns the
   * process signal handlers, so telemetry no longer registers its own.
   */
  async shutdown(): Promise<void> {
    const providers = [
      this.tracerProvider,
      this.meterProvider,
      this.loggerProvider,
    ].filter((p): p is NonNullable<typeof p> => p !== undefined);

    if (providers.length > 0) {
      this.tracerProvider = undefined;
      this.meterProvider = undefined;
      this.loggerProvider = undefined;
      this.shutdownPromise = (async () => {
        await Promise.all(
          providers.map(async (provider) => {
            try {
              await provider.shutdown();
            } catch (error) {
              logger.error("Error shutting down: %O", error);
            }
          }),
        );
      })();
    }

    return this.shutdownPromise;
  }
}
