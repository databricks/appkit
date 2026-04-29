// Type declarations for optional @databricks/appkit/type-generator module
declare module "@databricks/appkit/type-generator" {
  export function generateFromEntryPoint(options: {
    queryFolder?: string;
    outFile: string;
    warehouseId: string;
    noCache?: boolean;
  }): Promise<void>;

  export function generateServingTypes(options: {
    outFile: string;
    noCache?: boolean;
  }): Promise<void>;

  // ── Metric-view sync seam (consumed by the `metric sync` CLI subcommand) ──
  /**
   * Single column emitted into the build-time metric registry / metadata bundle.
   * Mirrors `MetricColumnMetadata` in the type-generator package.
   */
  export interface MetricColumnMetadata {
    name: string;
    type: string;
    isMeasure: boolean;
    description?: string;
    displayName?: string;
    format?: string;
    timeGrains?: string[];
  }

  /** Per-metric schema captured at type-generation time. */
  export interface MetricSchema {
    key: string;
    source: string;
    lane: "sp" | "obo";
    measures: MetricColumnMetadata[];
    dimensions: MetricColumnMetadata[];
  }

  /** Resolved entry consumed by the metric-view pipeline. */
  export interface MetricConfigResolution {
    entries: Array<{
      key: string;
      source: string;
      lane: "sp" | "obo";
    }>;
  }

  /** Shape of metric.json. */
  export interface MetricSourceConfig {
    $schema?: string;
    sp?: Record<string, { source: string }>;
    obo?: Record<string, { source: string }>;
  }

  export type DescribeFetcher = (fqn: string) => Promise<unknown>;

  export function readMetricConfig(
    queryFolder: string,
  ): Promise<MetricSourceConfig | null>;
  export function resolveMetricConfig(
    config: MetricSourceConfig,
  ): MetricConfigResolution;
  export function syncMetrics(
    resolution: MetricConfigResolution,
    fetcher: DescribeFetcher,
  ): Promise<MetricSchema[]>;
  export function createWorkspaceDescribeFetcher(
    warehouseId: string,
  ): DescribeFetcher;
  export function generateMetricTypeDeclarations(
    schemas: MetricSchema[],
  ): string;
  export function generateMetricsMetadataJson(schemas: MetricSchema[]): string;

  export const METRIC_TYPES_FILE: string;
  export const METRIC_METADATA_FILE: string;
  export const TYPES_DIR: string;
}
