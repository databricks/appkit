/**
 * `@databricks/appkit/database-tooling` — CLI-only logic behind `appkit db`.
 * Loaded lazily by the shared CLI; it may import drizzle-kit, so the runtime
 * plugin never imports it.
 */
export { createDbContext, type DbContext } from "./context";
export {
  type IntrospectOptions,
  type IntrospectReport,
  runIntrospect,
} from "./introspect";
export { type MigrateOptions, type MigrateReport, runMigrate } from "./migrate";
