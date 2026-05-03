import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  bullet,
  check,
  databasePaths,
  loadIntrospector,
  runCommandAction,
  splitCsv,
  warn,
  withLakebasePool,
} from "./shared";

export interface IntrospectOptions {
  schema?: string;
  exclude?: string;
  readonly?: boolean;
  merge?: boolean;
  dryRun?: boolean;
}

export async function runIntrospect(
  options: IntrospectOptions = {},
): Promise<void> {
  const paths = databasePaths();

  await withLakebasePool(async (pool) => {
    const { introspect, renderSchema } = await loadIntrospector();
    console.log(bullet("Connecting to Lakebase"));

    const result = await introspect(pool, {
      schemas: splitCsv(String(options.schema ?? "app,public")),
      exclude: splitCsv(String(options.exclude ?? "")),
      readonly: Boolean(options.readonly),
    });
    const tableCount = result.tables.length;
    const columnCount = result.tables.reduce(
      (sum, table) => sum + table.columns.length,
      0,
    );
    console.log(bullet(`Found ${tableCount} tables, ${columnCount} columns`));

    const source = renderSchema(result);
    if (options.dryRun) {
      console.log(source);
      return;
    }

    if (options.merge) {
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

    console.log(check(`Wrote ${path.relative(paths.root, paths.schemaFile)}`));
    console.log(
      check(`Wrote ${path.relative(paths.root, paths.baselineFile)}`),
    );
  });
}

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
  .action((opts) =>
    runCommandAction(async () => {
      await runIntrospect({
        schema: opts.schema ? String(opts.schema) : undefined,
        exclude: opts.exclude ? String(opts.exclude) : undefined,
        readonly: Boolean(opts.readonly),
        merge: Boolean(opts.merge),
        dryRun: Boolean(opts.dryRun),
      });
      if (!opts.dryRun) {
        console.log("");
        console.log("Next:");
        console.log("  npx appkit db verify");
        console.log("  npx appkit db migration generate --name <change>");
      }
    }),
  );
