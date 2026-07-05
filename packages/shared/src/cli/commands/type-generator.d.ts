/**
 * Ambient, intentionally narrowed mirror of `@databricks/appkit/type-generator`.
 *
 * `shared` is a leaf package and must not statically depend on `appkit`, so the
 * CLI loads the type-generator via a dynamic `import(...)` and this declares its
 * shape without a build-time dependency. There is NO compile-time link to the
 * real exports — if they change, re-sync this by hand against
 * `packages/appkit/src/type-generator/index.ts`.
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

  // Metric artifact filename (written as a sibling of the query out file). The
  // CLI joins this with the out file's directory to report the emitted path.
  export const METRIC_TYPES_FILE: string;
}
