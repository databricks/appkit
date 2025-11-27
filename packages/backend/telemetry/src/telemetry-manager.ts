import type { TelemetryOptions } from "@databricks-apps/types";
import { metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  type Instrumentation,
  registerInstrumentations as otelRegisterInstrumentations,
} from "@opentelemetry/instrumentation";
import {
  detectResourcesSync,
  envDetector,
  hostDetector,
  processDetector,
  Resource,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { TelemetryProvider } from "./telemetry-provider";
import type { TelemetryConfig } from "./types";

export class TelemetryManager {
  private static readonly DEFAULT_EXPORT_INTERVAL_MS = 10000;

  private static instance?: TelemetryManager;
  private static shutdownRegistered = false;
  private tracerProvider?: NodeTracerProvider;
  private meterProvider?: MeterProvider;
  private loggerProvider?: LoggerProvider;
  private isInitialized = false;

  private constructor() {}

  static getInstance(): TelemetryManager {
    if (!TelemetryManager.instance) {
      TelemetryManager.instance = new TelemetryManager();
    }
    return TelemetryManager.instance;
  }

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

  static initialize(config: Partial<TelemetryConfig> = {}): void {
    TelemetryManager.registerShutdown();
    const instance = TelemetryManager.getInstance();
    instance._initialize(config);
  }

  private _initialize(config: Partial<TelemetryConfig>): void {
    if (this.isInitialized) {
      return;
    }

    if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      console.log(
        "[Telemetry] OTEL_EXPORTER_OTLP_ENDPOINT not set; telemetry disabled",
      );
      this.isInitialized = true;
      return;
    }

    try {
      const resource = this.createResource(config);
      this.setupTraces(resource, config);
      this.setupMetrics(resource, config);
      this.setupLogs(resource, config);

      const instrumentations =
        config.instrumentations || this.getDefaultInstrumentations();
      otelRegisterInstrumentations({
        tracerProvider: this.tracerProvider,
        meterProvider: this.meterProvider,
        instrumentations,
      });

      this.isInitialized = true;
    } catch (error) {
      console.error("[Telemetry] Failed to initialize telemetry:", error);
      this.isInitialized = true;
    }
  }

  /**
   * Register OpenTelemetry instrumentations.
   * Can be called at any time, but recommended to call in plugin constructor.
   * @param instrumentations - Array of OpenTelemetry instrumentations to register
   */
  registerInstrumentations(instrumentations: Instrumentation[]): void {
    otelRegisterInstrumentations({
      tracerProvider: this.tracerProvider,
      meterProvider: this.meterProvider,
      instrumentations,
    });
  }

  private createResource(config: Partial<TelemetryConfig>): Resource {
    const serviceName =
      config.serviceName ||
      process.env.OTEL_SERVICE_NAME ||
      process.env.DATABRICKS_APP_NAME ||
      "databricks-app";

    const initialResource = new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: config.serviceVersion ?? undefined,
    });
    const detectedResource = detectResourcesSync({
      detectors: [envDetector, hostDetector, processDetector],
    });
    return initialResource.merge(detectedResource);
  }

  private setupTraces(
    resource: Resource,
    config: Partial<TelemetryConfig>,
  ): void {
    this.tracerProvider = new NodeTracerProvider({
      resource,
    });

    const traceExporter = new OTLPTraceExporter({
      // reads the endpoint automatically
      headers: config.headers || {},
    });

    const spanProcessor = new BatchSpanProcessor(traceExporter);
    this.tracerProvider.addSpanProcessor(spanProcessor);

    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();

    this.tracerProvider.register({
      contextManager: contextManager,
    });
  }

  private setupMetrics(
    resource: Resource,
    config: Partial<TelemetryConfig>,
  ): void {
    this.meterProvider = new MeterProvider({
      resource,
    });

    const metricExporter = new OTLPMetricExporter({
      // reads the endpoint automatically
      headers: config.headers || {},
    });

    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis:
        config.exportIntervalMs || TelemetryManager.DEFAULT_EXPORT_INTERVAL_MS,
    });

    this.meterProvider.addMetricReader(metricReader);
    metrics.setGlobalMeterProvider(this.meterProvider);
  }

  private setupLogs(
    resource: Resource,
    config: Partial<TelemetryConfig>,
  ): void {
    this.loggerProvider = new LoggerProvider({
      resource,
    });

    const logExporter = new OTLPLogExporter({
      // reads the endpoint automatically
      headers: config.headers || {},
    });

    const logProcessor = new BatchLogRecordProcessor(logExporter);
    this.loggerProvider.addLogRecordProcessor(logProcessor);
    logs.setGlobalLoggerProvider(this.loggerProvider);
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

  private static registerShutdown() {
    if (TelemetryManager.shutdownRegistered) {
      return;
    }

    const shutdownFn = async () => {
      await TelemetryManager.getInstance().shutdown();
    };
    process.once("SIGTERM", shutdownFn);
    process.once("SIGINT", shutdownFn);
    TelemetryManager.shutdownRegistered = true;
  }

  private async shutdown(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    try {
      if (this.tracerProvider) {
        await this.tracerProvider.shutdown();
        this.tracerProvider = undefined;
      }

      if (this.meterProvider) {
        await this.meterProvider.shutdown();
        this.meterProvider = undefined;
      }

      if (this.loggerProvider) {
        await this.loggerProvider.shutdown();
        this.loggerProvider = undefined;
      }

      this.isInitialized = false;
    } catch (error) {
      console.error("[Telemetry] Error shutting down:", error);
    }
  }
}
