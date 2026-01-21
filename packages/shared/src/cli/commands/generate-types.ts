import { Command } from "commander";
import path from "node:path";

/**
 * Generate types command implementation
 */
async function runGenerateTypes(
  rootDir?: string,
  outFile?: string,
  warehouseId?: string,
  options?: { noCache?: boolean },
) {
  try {
    // Try to import the type generator from @databricks/appkit
    const { generateFromEntryPoint } = await import(
      "@databricks/appkit/type-generator"
    );

    const resolvedRootDir = rootDir || process.cwd();
    const resolvedOutFile =
      outFile || path.join(process.cwd(), "client/src/appKitTypes.d.ts");

    const queryFolder = path.join(resolvedRootDir, "config/queries");

    const resolvedWarehouseId =
      warehouseId || process.env.DATABRICKS_WAREHOUSE_ID;
    if (!resolvedWarehouseId) {
      console.error(
        "Error: DATABRICKS_WAREHOUSE_ID is not set. Please provide it as an argument or environment variable.",
      );
      process.exit(1);
    }

    await generateFromEntryPoint({
      queryFolder,
      outFile: resolvedOutFile,
      warehouseId: resolvedWarehouseId,
      noCache: options?.noCache || false,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Cannot find module")
    ) {
      console.error(
        "Error: The 'generate-types' command is only available in @databricks/appkit.",
      );
      console.error("Please install @databricks/appkit to use this command.");
      process.exit(1);
    }
    throw error;
  }
}

export const generateTypesCommand = new Command("generate-types")
  .description("Generate TypeScript types from SQL queries")
  .argument("[rootDir]", "Root directory of the project", process.cwd())
  .argument(
    "[outFile]",
    "Output file path",
    path.join(process.cwd(), "client/src/appKitTypes.d.ts"),
  )
  .argument("[warehouseId]", "Databricks warehouse ID")
  .option("--no-cache", "Disable caching for type generation")
  .action(runGenerateTypes);
