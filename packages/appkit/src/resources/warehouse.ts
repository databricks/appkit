import { AsyncLocalStorage } from "node:async_hooks";

import { ConfigurationError } from "../errors";
import { AppResources, type AppResourceBindings } from "./app-resources";

// Only deprecated user-context overrides use this scope. New callers share app bindings.
const legacyResourceStorage = new AsyncLocalStorage<
  AppResourceBindings | undefined
>();

/** @internal Keep legacy resource overrides out of execution identity. */
export function runWithResourceBindings<T>(
  bindings: AppResourceBindings | undefined,
  fn: () => T,
): T {
  return legacyResourceStorage.run(bindings, fn);
}

/**
 * Get the configured SQL warehouse ID after app initialization.
 * The warehouse is an app resource; SP and caller executions use the same binding.
 * Deprecated user-context scopes retain support for explicit warehouse overrides.
 *
 * @throws ConfigurationError if no SQL warehouse was required at startup.
 * @throws InitializationError if the app resources are not initialized.
 */
export function getWarehouseId(): Promise<string> {
  const bindings = legacyResourceStorage.getStore() ?? AppResources.get();
  if (!bindings.warehouseId) {
    throw ConfigurationError.resourceNotFound(
      "Warehouse ID",
      "No plugin requires a SQL Warehouse. Add a sql_warehouse resource to your plugin manifest, or set DATABRICKS_WAREHOUSE_ID",
    );
  }
  return bindings.warehouseId;
}
