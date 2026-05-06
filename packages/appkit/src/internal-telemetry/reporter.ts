import type { WorkspaceClient } from "@databricks/sdk-experimental";
import {
  type AppkitLog,
  buildAppkitPayload,
  type RequestMetricsEvent,
} from "./appkit-log";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_METRICS_FLUSH_INTERVAL_MS = 60 * 1000;

interface ReporterOptions {
  workspaceId: Promise<string> | string;
  client: WorkspaceClient;
  appId: string;
  appkitVersion: string;
  heartbeatIntervalMs?: number;
  metricsFlushIntervalMs?: number;
}

interface RequestBucket {
  count: number;
  latencyMsTotal: number;
  http4xx: number;
  http5xx: number;
}

function envIntervalMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class TelemetryReporter {
  static #instance: TelemetryReporter | null = null;

  readonly #workspaceIdPromise: Promise<string>;
  readonly #client: WorkspaceClient;
  readonly #appId: string;
  readonly #appkitVersion: string;
  readonly #heartbeatIntervalMs: number;
  readonly #metricsFlushIntervalMs: number;

  #heartbeatTimer: NodeJS.Timeout | null = null;
  #metricsTimer: NodeJS.Timeout | null = null;
  #buckets: Map<string, RequestBucket> = new Map();

  private constructor(opts: ReporterOptions) {
    this.#workspaceIdPromise = Promise.resolve(opts.workspaceId);
    // Mark the rejection (if any) as handled so a misconfigured workspaceId
    // doesn't trigger an unhandled-rejection warning before the first #send
    // awaits it. The original promise still rejects when awaited.
    this.#workspaceIdPromise.catch(() => {});
    this.#client = opts.client;
    this.#appId = opts.appId;
    this.#appkitVersion = opts.appkitVersion;
    this.#heartbeatIntervalMs =
      opts.heartbeatIntervalMs ??
      envIntervalMs(
        "APPKIT_TELEMETRY_HEARTBEAT_INTERVAL_MS",
        DEFAULT_HEARTBEAT_INTERVAL_MS,
      );
    this.#metricsFlushIntervalMs =
      opts.metricsFlushIntervalMs ??
      envIntervalMs(
        "APPKIT_TELEMETRY_METRICS_FLUSH_INTERVAL_MS",
        DEFAULT_METRICS_FLUSH_INTERVAL_MS,
      );
  }

  static initialize(opts: ReporterOptions): TelemetryReporter {
    TelemetryReporter.#instance?.stop();
    TelemetryReporter.#instance = new TelemetryReporter(opts);
    return TelemetryReporter.#instance;
  }

  static getInstance(): TelemetryReporter | null {
    return TelemetryReporter.#instance;
  }

  /** @internal Test-only reset. */
  static _reset(): void {
    TelemetryReporter.#instance?.stop();
    TelemetryReporter.#instance = null;
  }

  start(): void {
    if (this.#heartbeatTimer || this.#metricsTimer) return;
    this.#heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch(() => {});
    }, this.#heartbeatIntervalMs);
    this.#heartbeatTimer.unref?.();

    this.#metricsTimer = setInterval(() => {
      this.flushRequestMetrics().catch(() => {});
    }, this.#metricsFlushIntervalMs);
    this.#metricsTimer.unref?.();
  }

  stop(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (this.#metricsTimer) clearInterval(this.#metricsTimer);
    this.#heartbeatTimer = null;
    this.#metricsTimer = null;
  }

  recordRequest(
    method: string,
    routeTemplate: string,
    statusCode: number,
    latencyMs: number,
  ): void {
    if (!routeTemplate) return;
    const key = `${method.toUpperCase()} ${routeTemplate}`;
    const bucket = this.#buckets.get(key) ?? {
      count: 0,
      latencyMsTotal: 0,
      http4xx: 0,
      http5xx: 0,
    };
    bucket.count += 1;
    bucket.latencyMsTotal += Math.max(0, latencyMs);
    if (statusCode >= 400 && statusCode < 500) bucket.http4xx += 1;
    if (statusCode >= 500 && statusCode < 600) bucket.http5xx += 1;
    this.#buckets.set(key, bucket);
  }

  async sendStartup(): Promise<void> {
    await this.#send([
      this.#wrap({ event_name: "APP_STARTUP", app_startup_event: {} }),
    ]);
  }

  async sendHeartbeat(): Promise<void> {
    await this.#send([
      this.#wrap({ event_name: "HEARTBEAT", heartbeat_event: {} }),
    ]);
  }

  async flushRequestMetrics(): Promise<void> {
    if (this.#buckets.size === 0) return;
    const drained = this.#buckets;
    this.#buckets = new Map();

    const logs: AppkitLog[] = [];
    for (const [endpoint, bucket] of drained) {
      const event: RequestMetricsEvent = {
        endpoint,
        request_count: bucket.count,
        request_latency_ms_avg: Math.round(
          bucket.latencyMsTotal / bucket.count,
        ),
        response_count_http4xx: bucket.http4xx,
        response_count_http5xx: bucket.http5xx,
      };
      logs.push(
        this.#wrap({
          event_name: "REQUEST_METRICS",
          request_metrics_event: event,
        }),
      );
    }
    await this.#send(logs);
  }

  #wrap(partial: AppkitLog): AppkitLog {
    return {
      ...partial,
      app_id: this.#appId,
      appkit_version: this.#appkitVersion,
    };
  }

  async #send(logs: AppkitLog[]): Promise<void> {
    if (logs.length === 0) return;
    const workspaceId = await this.#workspaceIdPromise;
    await this.#client.apiClient.request({
      path: "/telemetry-ext",
      method: "POST",
      query: { o: workspaceId },
      headers: new Headers(),
      payload: buildAppkitPayload(logs),
      raw: false,
    });
  }
}
