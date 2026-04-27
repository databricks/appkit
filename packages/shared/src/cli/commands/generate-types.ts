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
    const resolvedRootDir = rootDir || process.cwd();
    const noCache = options?.noCache || false;

    const typeGen = await import("@databricks/appkit/type-generator");

    // Generate analytics query types (requires warehouse ID)
    const resolvedWarehouseId =
      warehouseId || process.env.DATABRICKS_WAREHOUSE_ID;

    if (resolvedWarehouseId) {
      const resolvedOutFile =
        outFile ||
        path.join(process.cwd(), "shared/appkit-types/analytics.d.ts");

      const queryFolder = path.join(resolvedRootDir, "config/queries");
      if (fs.existsSync(queryFolder)) {
        await typeGen.generateFromEntryPoint({
          queryFolder,
          outFile: resolvedOutFile,
          warehouseId: resolvedWarehouseId,
          noCache,
        });
        console.log(`Generated query types: ${resolvedOutFile}`);
      }
    } else {
      console.error(
        "Skipping query type generation: no warehouse ID. Set DATABRICKS_WAREHOUSE_ID or pass as argument.",
      );
    }

    // Generate serving endpoint types (no warehouse required)
    const servingOutFile = path.join(
      process.cwd(),
      "shared/appkit-types/serving.d.ts",
    );
    await typeGen.generateServingTypes({
      outFile: servingOutFile,
      noCache,
    });
    console.log(`Generated serving types: ${servingOutFile}`);
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
    path.join(process.cwd(), "shared/appkit-types/analytics.d.ts"),
  )
  .argument("[warehouseId]", "Databricks warehouse ID")
  .option("--no-cache", "Disable caching for type generation")
  .addHelpText(
    "after",
    `
Examples:
  $ appkit generate-types
  $ appkit generate-types . shared/appkit-types/analytics.d.ts
  $ appkit generate-types . shared/appkit-types/analytics.d.ts my-warehouse-id
  $ appkit generate-types --no-cache`,
  )
  .action(runGenerateTypes);
