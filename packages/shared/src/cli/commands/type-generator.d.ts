/**
 * Intentionally narrowed mirror of `@databricks/appkit/type-generator`.
 *
 * `shared` is a leaf package and must not statically depend on `appkit`, so the
 * CLI loads the type-generator via a dynamic `import(...)` and this declares its
 * shape without a build-time dependency. There is NO compile-time link to the
 * real exports — if they change, re-sync this by hand against
 * `packages/appkit/src/type-generator/index.ts`.
 */
declare module "@databricks/appkit/type-generator" {
  export const DATABASE_TYPES_FILE: "database.d.ts";

  export function generateDatabaseTypes(options: {
    schemaFile: string;
    outFile: string;
  }): Promise<void>;

  export function generateFromEntryPoint(options: {
    queryFolder?: string;
    metricViewsFolder?: string;
    outFile: string;
    warehouseId: string;
    noCache?: boolean;
    mode?: "non-blocking" | "blocking";
  }): Promise<void>;

  export class TypegenSyntaxError extends Error {
    readonly queries: Array<{ name: string; message: string }>;
    readonly fatalQueries: Array<{ name: string; message: string }>;
  }

  export class TypegenFatalError extends Error {
    readonly queries: Array<{ name: string; message: string }>;
  }

  export class DatabaseTypegenError extends Error {}

  export function generateServingTypes(options: {
    outFile: string;
    noCache?: boolean;
  }): Promise<void>;
}
