import type { TelemetryOptions } from "shared";
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
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { AlwaysOnSampler } from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { TelemetryProvider } from "./telemetry-provider";
import type { TelemetryConfig } from "./types";
import { NodeSDK } from "@opentelemetry/sdk-node";

export class TelemetryManager {
  private static readonly DEFAULT_EXPORT_INTERVAL_MS = 10000;
  private static readonly DEFAULT_FALLBACK_APP_NAME = "databricks-app";

  private static instance?: TelemetryManager;
  private sdk?: NodeSDK;

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

  private _initialize(config: Partial<TelemetryConfig>): void {
    if (this.sdk) return;

    if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      console.log(
        "[Telemetry] OTEL_EXPORTER_OTLP_ENDPOINT not set; telemetry disabled",
      );
      return;
    }

    try {
      this.sdk = new NodeSDK({
        resource: this.createResource(config),
        autoDetectResources: false,
        sampler: new AlwaysOnSampler(),
        traceExporter: new OTLPTraceExporter({ headers: config.headers }),
        metricReaders: [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ headers: config.headers }),
            exportIntervalMillis:
              config.exportIntervalMs ||
              TelemetryManager.DEFAULT_EXPORT_INTERVAL_MS,
          }),
        ],
        logRecordProcessors: [
          new BatchLogRecordProcessor(
            new OTLPLogExporter({ headers: config.headers }),
          ),
        ],
        instrumentations: this.getDefaultInstrumentations(),
      });

      this.sdk.start();
      this.registerShutdown();
      console.log("[Telemetry] Initialized successfully");
    } catch (error) {
      console.error("[Telemetry] Failed to initialize:", error);
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

  private registerShutdown() {
    const shutdownFn = async () => {
      await TelemetryManager.getInstance().shutdown();
    };
    process.once("SIGTERM", shutdownFn);
    process.once("SIGINT", shutdownFn);
  }

  private async shutdown(): Promise<void> {
    if (!this.sdk) {
      return;
    }

    try {
      await this.sdk.shutdown();
      this.sdk = undefined;
    } catch (error) {
      console.error("[Telemetry] Error shutting down:", error);
    }
  }
}
