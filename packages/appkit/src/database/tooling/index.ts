/**
 * `@databricks/appkit/beta/database-tooling` — CLI-only logic behind `appkit db`.
 * Loaded lazily by the shared CLI; it may import drizzle-kit, so the runtime
 * plugin never imports it.
 *
 * Beta and internal to the AppKit CLI: it has no semver guarantee, and only
 * the CLI of the same AppKit release should import it.
 */
export { createDbContext, type DbContext } from "./context";
export { type MigrateOptions, type MigrateReport, runMigrate } from "./migrate";
