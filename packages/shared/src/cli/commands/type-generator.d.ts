/**
 * Ambient, intentionally NARROWED mirror of `@databricks/appkit/type-generator`.
 *
 * `shared` must not statically depend on `appkit` (it is a leaf package), so the
 * CLI reaches appkit's type-generator through a dynamic
 * `import("@databricks/appkit/type-generator")`; this declaration types that
 * import without a build-time dependency on appkit.
 *
 * The mirror is deliberately narrower than the real export: array element types
 * are widened to `unknown[]`, options the CLI never passes (e.g. `metricFetcher`)
 * are omitted, and only the surface the CLI actually uses is declared.
 *
 * DRIFT WARNING: there is NO compile-time link to appkit's real types — if the
 * real `generateFromEntryPoint` / `syncMetricViewsTypes` (or their result
 * shapes) change, this declaration will NOT fail to compile and must be
 * re-synced by hand against `packages/appkit/src/type-generator/index.ts`.
 */
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
    // Per-key fatal preflight errors. Always empty for `mv sync` (the CLI uses
    // the default `describe-now` mode); populated only by the dev/Vite blocking
    // path. Declared to match the real export's result contract.
    fatalErrors: Array<{ name: string; message: string }>;
  }

  /**
   * Generate the metric-view type artifacts used by `appkit mv sync`.
   *
   * Reads `metric-views.json` from `queryFolder`, DESCRIBEs any metric views
   * that are missing from the cache, then writes `metric-views.d.ts` and
   * `metric-views.metadata.json`. This only syncs metric-view types; analytics query
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
    // Preflight policy (mirrors the real export). The CLI omits it for the
    // default `"describe-now"` (DESCRIBE now, degrade on a cold warehouse) and
    // passes `"blocking"` under `--wait` (wait for / start the warehouse; only a
    // deleted one is fatal). `"non-blocking"` is the dev/Vite path.
    mode?: "describe-now" | "non-blocking" | "blocking";
  }): Promise<SyncMetricViewsTypesResult>;

  export const METRIC_TYPES_FILE: string;
  export const METRIC_METADATA_FILE: string;
}
