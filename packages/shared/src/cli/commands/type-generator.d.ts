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
    // Optional sink for the blocking-mode cold-start "still waiting" notice,
    // invoked at most once (and only in blocking mode). The CLI passes a console
    // printer so a `--wait` run isn't silent during a multi-minute warehouse
    // warm-up.
    report?: (msg: string) => void;
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
