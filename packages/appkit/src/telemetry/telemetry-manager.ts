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
import { NodeSDK } from "@opentelemetry/sdk-node";
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

  static async initialize(
    config: Partial<TelemetryConfig> = {},
  ): Promise<void> {
    const instance = TelemetryManager.getInstance();
    await instance._initialize(config);
  }

  private async _initialize(config: Partial<TelemetryConfig>): Promise<void> {
    if (this.sdk) return;

    if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      return;
    }

    try {
      const traceHeaders = await this.buildTraceExporterHeaders(
        config.headers,
        config.traceExporterHeaders,
      );

      this.sdk = new NodeSDK({
        resource: this.createResource(config),
        autoDetectResources: false,
        sampler: new AppKitSampler(),
        traceExporter: new OTLPTraceExporter({ headers: traceHeaders }),
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
        instrumentations:
          config.instrumentations ?? this.getDefaultInstrumentations(),
      });

      this.sdk.start();
      this.registerShutdown();
      logger.debug("Initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize: %O", error);
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

  /**
   * Builds headers for the trace exporter by merging (in priority order):
   *   1. Base `headers` from TelemetryConfig
   *   2. Databricks auth (auto-resolved when DATABRICKS_HOST is set)
   *   3. Plugin-contributed `traceExporterHeaders` (e.g. MLflow experiment ID)
   */
  private async buildTraceExporterHeaders(
    configHeaders?: Record<string, string>,
    pluginHeaders?: Record<string, string>,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...configHeaders };

    if (process.env.DATABRICKS_HOST && !headers.authorization) {
      try {
        const { WorkspaceClient } = await import(
          "@databricks/sdk-experimental"
        );
        const client = new WorkspaceClient({});
        const authHeaders = new Headers();
        await client.config.authenticate(authHeaders);
        authHeaders.forEach((value, key) => {
          headers[key] = value;
        });
      } catch (err) {
        logger.warn(
          "Could not obtain Databricks auth for trace exporter: %O",
          err,
        );
      }
    }

    if (pluginHeaders) {
      Object.assign(headers, pluginHeaders);
    }

    return headers;
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
      logger.error("Error shutting down: %O", error);
    }
  }
}
