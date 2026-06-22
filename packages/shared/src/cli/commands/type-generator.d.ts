// Type declarations for optional @databricks/appkit/type-generator module
declare module "@databricks/appkit/type-generator" {
  export function generateFromEntryPoint(options: {
    queryFolder?: string;
    outFile: string;
    warehouseId: string;
    noCache?: boolean;
    // Warehouse preflight policy. "non-blocking" never probes the warehouse and
    // never describes (emits cached/`unknown` types and returns immediately);
    // "blocking" waits for a startable warehouse and treats a stopped one as
    // fatal.
    mode?: "non-blocking" | "blocking";
  }): Promise<void>;

  export class TypegenSyntaxError extends Error {
    readonly queries: Array<{ name: string; message: string }>;
    readonly fatalQueries: Array<{ name: string; message: string }>;
  }

  export class TypegenFatalError extends Error {
    readonly queries: Array<{ name: string; message: string }>;
  }

  export function generateServingTypes(options: {
    outFile: string;
    noCache?: boolean;
  }): Promise<void>;

  /** Execution lane: `sp` (service principal) or `obo` (on-behalf-of). */
  type MetricLane = "sp" | "obo";

  /** Per-metric schema captured by {@link syncMetricViewsTypes}. */
  interface MetricSchema {
    key: string;
    source: string;
    lane: MetricLane;
    measures: unknown[];
    dimensions: unknown[];
    degraded?: boolean;
  }

  /** One per-entry DESCRIBE failure surfaced by the metric sync. */
  interface MetricSyncFailure {
    key: string;
    source: string;
    reason: string;
    transient: boolean;
  }

  /** Result of {@link syncMetricViewsTypes}. */
  interface SyncMetricViewsTypesResult {
    metricOutFile?: string;
    metricMetadataOutFile?: string;
    schemas: MetricSchema[];
    failures: MetricSyncFailure[];
    /** `true` when no metric-views.json was found — nothing was synced. */
    noConfig: boolean;
  }

  /**
   * Metric-only sync entry: read metric-views.json from `queryFolder`, DESCRIBE
   * every entry (minus clean cache hits), and write `metric.d.ts` +
   * `metrics.metadata.json`. Does NOT generate analytics query types. Backs
   * `appkit mv sync`. `cache` defaults to ON; only `cache === false` (the
   * CLI's `--no-cache`) disables the shared metric type-generation cache.
   */
  export function syncMetricViewsTypes(options: {
    queryFolder: string;
    warehouseId: string;
    metricOutFile: string;
    metricMetadataOutFile: string;
    cache?: boolean;
  }): Promise<SyncMetricViewsTypesResult>;

  /** Default filename for the generated MetricRegistry declarations. */
  export const METRIC_TYPES_FILE: string;
  /** Default filename for the build-time semantic-metadata JSON bundle. */
  export const METRIC_METADATA_FILE: string;
}
