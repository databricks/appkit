import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  bullet,
  check,
  cross,
  databasePaths,
  loadIntrospector,
  openLakebasePool,
  splitCsv,
  warn,
} from "./shared";

export const introspectCommand = new Command("introspect")
  .description(
    "Snapshot a live Lakebase database into config/database/schema.ts",
  )
  .option(
    "-s, --schema <names>",
    "Comma-separated schemas to include",
    "app,public",
  )
  .option("-x, --exclude <tables>", "Comma-separated tables to skip", "")
  .option("--readonly", "Mark all tables as external")
  .option(
    "--merge",
    "Merge changes into existing schema.ts instead of overwriting",
  )
  .option("--dry-run", "Print schema.ts to stdout instead of writing")
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
      const { introspect, renderSchema } = await loadIntrospector();
      console.log(bullet("Connecting to Lakebase"));

      const result = await introspect(pool, {
        schemas: splitCsv(String(opts.schema)),
        exclude: splitCsv(String(opts.exclude)),
        readonly: Boolean(opts.readonly),
      });
      const tableCount = result.tables.length;
      const columnCount = result.tables.reduce(
        (sum, table) => sum + table.columns.length,
        0,
      );
      console.log(bullet(`Found ${tableCount} tables, ${columnCount} columns`));

      const source = renderSchema(result);
      if (opts.dryRun) {
        console.log(source);
        return;
      }

      if (opts.merge) {
        console.log(
          warn("--merge is not implemented yet; overwriting schema.ts."),
        );
      }

      await fs.mkdir(paths.configDir, { recursive: true });
      await fs.writeFile(paths.schemaFile, source, "utf8");

      await fs.mkdir(paths.migrationsDir, { recursive: true });
      await fs.writeFile(
        paths.baselineFile,
        JSON.stringify(result, null, 2),
        "utf8",
      );

      console.log(
        check(`Wrote ${path.relative(paths.root, paths.schemaFile)}`),
      );
      console.log(
        check(`Wrote ${path.relative(paths.root, paths.baselineFile)}`),
      );
      console.log("");
      console.log("Next:");
      console.log("  npx appkit db verify");
      console.log("  npx appkit db generate --name <change>");
    } finally {
      await pool.end();
    }
  });
