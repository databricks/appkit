// Type declarations for optional @databricks/appkit/type-generator module
declare module "@databricks/appkit/type-generator" {
  export function generateFromEntryPoint(options: {
    queryFolder?: string;
    outFile: string;
    warehouseId: string;
    noCache?: boolean;
    // Warehouse preflight policy. "dev" never blocks the developer; "blocking"
    // waits for a startable warehouse and treats a stopped one as fatal;
    // "degrade" never probes the warehouse and never describes (emits
    // cached/`unknown` types and returns immediately).
    mode?: "dev" | "blocking" | "degrade";
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
}
