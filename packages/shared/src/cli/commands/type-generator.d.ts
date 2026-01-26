// Type declarations for optional @databricks/appkit/type-generator module
declare module "@databricks/appkit/type-generator" {
  export function generateFromEntryPoint(options: {
    queryFolder: string;
    outFile: string;
    warehouseId: string;
    noCache: boolean;
  }): Promise<void>;
}
