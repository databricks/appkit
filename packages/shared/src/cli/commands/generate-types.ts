import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";

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
    const resolvedWarehouseId =
      warehouseId || process.env.DATABRICKS_WAREHOUSE_ID;

    if (!resolvedWarehouseId) {
      process.exit(0);
    }

    // Try to import the type generator from @databricks/appkit
    const { generateFromEntryPoint } = await import(
      "@databricks/appkit/type-generator"
    );

    const resolvedRootDir = rootDir || process.cwd();
    const resolvedOutFile =
      outFile || path.join(process.cwd(), "client/src/appKitTypes.d.ts");

    const queryFolder = path.join(resolvedRootDir, "config/queries");
    if (!fs.existsSync(queryFolder)) {
      console.warn(
        `Warning: No queries found at ${queryFolder}. Skipping type generation.`,
      );
      return;
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
