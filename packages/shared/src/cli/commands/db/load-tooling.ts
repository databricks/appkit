import type { DatabaseTooling } from "./tooling-contract";

/** The appkit tooling, loaded on first use and typed by the checked contract. */
export function loadDatabaseTooling(): Promise<DatabaseTooling> {
  return import("@databricks/appkit/beta/database-tooling");
}
