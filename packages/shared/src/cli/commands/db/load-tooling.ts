import type { DatabaseTooling } from "./tooling-contract";

export function loadDatabaseTooling(): Promise<DatabaseTooling> {
  return import("@databricks/appkit/beta/database-tooling");
}
