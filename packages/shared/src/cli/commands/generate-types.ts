import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";

/**
 * Resolve the typegen pre-flight mode for the CLI. Defaults to "blocking" — a
 * deliberate/CI invocation should wait for a starting warehouse and fail fast on
 * a stopped one. `--no-block` (commander sets `block: false`) switches to
 * "degrade": a one-shot CLI can't describe in the background, so this mode never
 * describes at all — it skips the warehouse probe AND every DESCRIBE, emits
 * best-available types (cache where the SQL hash matches, else `result: unknown`)
 * and returns immediately. The scaffolded template's postinstall/predev use it so
 * they never block on — or get slowed by — a warehouse, even a RUNNING one.
 */
export function resolveTypegenMode(options?: {
  block?: boolean;
}): "dev" | "blocking" | "degrade" {
  return options?.block === false ? "degrade" : "blocking";
}

/**
 * Generate types command implementation
 */
async function runGenerateTypes(
  rootDir?: string,
  outFile?: string,
  warehouseId?: string,
  options?: { noCache?: boolean; block?: boolean },
) {
  try {
    const resolvedRootDir = rootDir || process.cwd();
    const noCache = options?.noCache || false;
    const mode = resolveTypegenMode(options);

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
          mode,
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
    // TypegenSyntaxError / TypegenFatalError carry a complete, actionable
    // message (which queries failed and how to debug them). The stack trace
    // points into appkit internals and is noise for app developers, so print
    // only the message and exit non-zero instead of letting it bubble up.
    if (
      error instanceof Error &&
      (error.name === "TypegenSyntaxError" ||
        error.name === "TypegenFatalError")
    ) {
      console.error(error.message);
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
  .option(
    "--no-block",
    "Degrade instead of blocking on warehouse readiness (use for postinstall)",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ appkit generate-types
  $ appkit generate-types . shared/appkit-types/analytics.d.ts
  $ appkit generate-types . shared/appkit-types/analytics.d.ts my-warehouse-id
  $ appkit generate-types --no-cache
  $ appkit generate-types --no-block   # postinstall: never block/fail on a cold warehouse`,
  )
  .action(runGenerateTypes);
