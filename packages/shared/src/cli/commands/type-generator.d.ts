/**
 * Ambient, intentionally NARROWED mirror of `@databricks/appkit/type-generator`.
 *
 * `shared` must not statically depend on `appkit` (it is a leaf package), so the
 * CLI reaches appkit's type-generator through a dynamic
 * `import("@databricks/appkit/type-generator")`; this declaration types that
 * import without a build-time dependency on appkit.
 *
 * The mirror is deliberately narrower than the real export: it declares only the
 * surface the `generate-types` CLI actually uses — `generateFromEntryPoint`
 * (which emits query AND, additively, metric-view types), `generateServingTypes`,
 * the two error classes the CLI catches by `name`, and the metric artifact
 * filename constants the CLI uses to report the emitted paths. Metric-view types
 * are produced inside `generateFromEntryPoint`, so the CLI no longer calls
 * `syncMetricViewsTypes` directly and that export is not mirrored.
 *
 * DRIFT WARNING: there is NO compile-time link to appkit's real types — if the
 * real `generateFromEntryPoint` / `generateServingTypes` (or the exported
 * constants) change, this declaration will NOT fail to compile and must be
 * re-synced by hand against `packages/appkit/src/type-generator/index.ts`.
 */
declare module "@databricks/appkit/type-generator" {
  export function generateFromEntryPoint(options: {
    queryFolder?: string;
    outFile: string;
    warehouseId: string;
    noCache?: boolean;
    // Warehouse preflight policy. "non-blocking" emits cached/`unknown` query
    // types and permissive metric types and returns immediately, warning on any
    // degraded/failed metric view; "blocking" (the CLI's `--wait`) waits for a
    // startable warehouse, treats a stopped one as fatal, and fails the run on
    // any metric view that still can't be described.
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

  // Metric artifact filenames (written as siblings of the query out file). The
  // CLI joins these with the out file's directory to report the emitted paths.
  export const METRIC_TYPES_FILE: string;
  export const METRIC_METADATA_FILE: string;
}
