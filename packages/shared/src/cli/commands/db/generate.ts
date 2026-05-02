import path from "node:path";
import { Command } from "commander";
import { execa } from "execa";
import { bullet, check, cross, databasePaths } from "./shared";

export const generateCommand = new Command("generate")
  .alias("g")
  .description("Generate the next migration from config/database/schema.ts")
  .option("--name <name>", "Optional migration name")
  .action(async (opts) => {
    const paths = databasePaths();
    const args = [
      "drizzle-kit",
      "generate",
      "--out",
      path.relative(paths.root, paths.migrationsDir),
      "--schema",
      path.relative(paths.root, paths.schemaFile),
      "--dialect",
      "postgresql",
    ];
    if (opts.name) args.push("--name", String(opts.name));

    console.log(bullet(`npx ${args.join(" ")}`));
    try {
      await execa("npx", args, {
        cwd: paths.root,
        stdio: "inherit",
        env: process.env,
      });
      console.log(
        check("Migration generated under config/database/migrations."),
      );
    } catch (error) {
      console.error(
        cross(`drizzle-kit generate failed: ${(error as Error).message}`),
      );
      process.exit(1);
    }
  });
