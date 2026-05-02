import path from "node:path";
import { Command } from "commander";
import { execa } from "execa";
import { bullet, check, cross, databasePaths } from "./shared";

export const migrateCommand = new Command("migrate")
  .description("Run database migrations")
  .addCommand(
    new Command("up")
      .description("Apply pending migrations")
      .action(() => runDrizzle(["migrate"])),
  )
  .addCommand(
    new Command("status")
      .description("Show migration status")
      .action(() => runDrizzle(["check"])),
  )
  .addCommand(
    new Command("reset")
      .description("Drop generated migrations metadata in development")
      .action(() => {
        if (process.env.NODE_ENV === "production") {
          console.error(cross("db migrate reset is forbidden in production."));
          process.exit(1);
        }
        return runDrizzle(["drop"]);
      }),
  );

async function runDrizzle(command: string[]): Promise<void> {
  const paths = databasePaths();
  const args = [
    "drizzle-kit",
    ...command,
    "--out",
    path.relative(paths.root, paths.migrationsDir),
    "--schema",
    path.relative(paths.root, paths.schemaFile),
    "--dialect",
    "postgresql",
  ];

  console.log(bullet(`npx ${args.join(" ")}`));
  try {
    await execa("npx", args, {
      cwd: paths.root,
      stdio: "inherit",
      env: process.env,
    });
    console.log(check("Done."));
  } catch (error) {
    console.error(
      cross(
        `drizzle-kit ${command.join(" ")} failed: ${(error as Error).message}`,
      ),
    );
    process.exit(1);
  }
}
