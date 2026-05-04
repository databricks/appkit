import path from "node:path";
import { Command } from "commander";
import { bullet, check, databasePaths, runCommandAction } from "./shared";

/**
 * Dev-only runtime shape of `@databricks/appkit`'s database type-generator.
 *
 * We import at runtime (same pattern as `loadIntrospector` in `shared.ts`) so
 * the CLI process can bypass tsdown's static analysis and pull the generator
 * in from the user's own `node_modules/@databricks/appkit`. Keeps the shared
 * package free of direct `@databricks/appkit` imports at bundle time.
 */
interface AppKitTypeGenModule {
  generateDatabaseTypes: (options: {
    outFile: string;
    projectRoot: string;
    noCache?: boolean;
  }) => Promise<void>;
  DATABASE_TYPES_FILE: string;
}

export interface GenerateTypesOptions {
  /** Skip the on-disk hash cache; always walk the schema and re-emit. */
  force?: boolean;
  /** Override the output path relative to the project root. */
  out?: string;
}

export const typesCommand = new Command("types")
  .description("Database type-generator commands")
  .addCommand(
    new Command("generate")
      .description(
        "Regenerate shared/appkit-types/database.d.ts from config/database/schema.ts",
      )
      .option(
        "--force",
        "Bypass the on-disk hash cache and re-emit the file unconditionally",
      )
      .option(
        "-o, --out <path>",
        "Write the .d.ts to this path (relative to the project root)",
      )
      .action((opts) =>
        runCommandAction(() =>
          generateTypes({
            force: Boolean(opts.force),
            out: opts.out ? String(opts.out) : undefined,
          }),
        ),
      ),
  );

/**
 * Escape hatch for the Vite plugin. In dev the plugin regenerates on save,
 * but developers sometimes need to re-emit without bouncing Vite — typical
 * cases: the generated `.d.ts` was deleted by a `git clean -fdX`, or a cache
 * HIT wrote a stale cached output and `--force` is needed to rebuild from
 * `schema.ts` bytes.
 */
export async function generateTypes(
  options: GenerateTypesOptions = {},
): Promise<void> {
  const paths = databasePaths();
  const mod = await loadTypeGenerator();
  const outFile = options.out
    ? path.resolve(paths.root, options.out)
    : path.resolve(paths.root, mod.DATABASE_TYPES_FILE);

  console.log(bullet(`Generating ${path.relative(paths.root, outFile)}`));
  await mod.generateDatabaseTypes({
    projectRoot: paths.root,
    outFile,
    noCache: Boolean(options.force),
  });
  console.log(check("Types generated."));
}

/**
 * Hide the specifier behind `new Function` so tsdown can't see the import
 * target and rewrite it into a `require`. Matches the pattern used by the
 * other CLI loaders (`loadIntrospector`, `loadSchemaFile`) — the appkit
 * package must resolve out of the user app's `node_modules`, not ours.
 */
function loadTypeGenerator(): Promise<AppKitTypeGenModule> {
  const importer = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<AppKitTypeGenModule>;
  return importer("@databricks/appkit");
}
