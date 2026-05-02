import { Command } from "commander";
import {
  bullet,
  check,
  cross,
  databasePaths,
  loadIntrospector,
  loadSchemaFile,
  openLakebasePool,
  warn,
} from "./shared";

export const verifyCommand = new Command("verify")
  .description("Compare config/database/schema.ts against live Lakebase state")
  .option("--explain", "Print the structured drift report")
  .action(async (opts) => {
    const paths = databasePaths();
    const pool = await openLakebasePool();
    if (!pool) {
      console.error(
        cross("No Lakebase connection. Set LAKEBASE_ENDPOINT or PGHOST."),
      );
      process.exit(1);
      return;
    }

    try {
      const schema = await loadSchemaFile(paths.schemaFile);
      if (!schema) {
        console.error(cross("config/database/schema.ts not found."));
        process.exit(1);
        return;
      }

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
      console.log("Resolve with one of:");
      console.log("   npx appkit db migrate up");
      console.log("   npx appkit db introspect --merge");

      if (opts.explain) {
        console.log("");
        console.log("Full diff:");
        console.log(JSON.stringify(report, null, 2));
      }
      process.exit(1);
    } finally {
      await pool.end();
    }
  });
