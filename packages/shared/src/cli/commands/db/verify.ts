import { Command } from "commander";
import {
  bullet,
  check,
  databasePaths,
  loadDriftHelp,
  loadIntrospector,
  loadSchemaFile,
  runCommandAction,
  warn,
  withLakebasePool,
} from "./shared";

export interface VerifyOptions {
  explain?: boolean;
}

export const verifyCommand = new Command("verify")
  .description("Compare config/database/schema.ts against live Lakebase state")
  .option("--explain", "Print the structured drift report")
  .action((opts) =>
    runCommandAction(() => verifyDatabase({ explain: Boolean(opts.explain) })),
  );

export async function verifyDatabase(
  options: VerifyOptions = {},
): Promise<void> {
  const paths = databasePaths();
  const schema = await loadSchemaFile(paths.schemaFile);
  if (!schema) {
    throw new Error("config/database/schema.ts not found.");
  }

  await withLakebasePool(async (pool) => {
    const { introspect, diffIntrospections, schemaToIntrospection } =
      await loadIntrospector();
    console.log(bullet("Comparing schema.ts against Lakebase"));

    const live = await introspect(pool);
    const declared = schemaToIntrospection(schema);
    const report = diffIntrospections(live, declared);

    if (!report.hasDrift) {
      console.log(check("In sync."));
      return;
    }

    console.log(warn("Drift detected:"));
    for (const entry of report.entries) {
      const icon =
        entry.kind === "live-only"
          ? "+"
          : entry.kind === "schema-only"
            ? "-"
            : "~";
      console.log(`   ${icon} ${entry.message}`);
    }
    console.log("");
    const { formatDriftResolution } = await loadDriftHelp();
    console.log(formatDriftResolution());

    if (options.explain) {
      console.log("");
      console.log("Full diff:");
      console.log(JSON.stringify(report, null, 2));
    }
    throw new Error("Database schema drift detected.");
  });
}
