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
    // `true` when no metric-views.json was found — nothing was synced.
    noConfig: boolean;
  }

  /**
   * Generate the metric-view type artifacts used by `appkit mv sync`.
   *
   * Reads `metric-views.json` from `queryFolder`, DESCRIBEs any metric views
   * that are missing from the cache, then writes `metric.d.ts` and
   * `metrics.metadata.json`. This only syncs metric-view types; analytics query
   * types are generated separately.
   *
   * The cache is enabled by default. Pass `cache: false` to force fresh
   * DESCRIBE results, matching the CLI's `--no-cache` flag.
   */
  export function syncMetricViewsTypes(options: {
    queryFolder: string;
    warehouseId: string;
    metricOutFile: string;
    metricMetadataOutFile: string;
    cache?: boolean;
  }): Promise<SyncMetricViewsTypesResult>;

  export const METRIC_TYPES_FILE: string;
  export const METRIC_METADATA_FILE: string;
}
