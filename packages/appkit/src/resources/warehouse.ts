import { AsyncLocalStorage } from "node:async_hooks";

import { ConfigurationError, InitializationError } from "../errors";
import type { sql, WorkspaceClient } from "../workspace-client";

/** The SQL warehouse selected for the app lifecycle, separate from identity. */
export interface WarehouseBinding {
  readonly warehouseId?: Promise<string>;
}

let appBinding: WarehouseBinding | undefined;

/** Owns SQL warehouse discovery and the app's immutable warehouse binding. */
export class WarehouseResource {
  /** Resolve candidates without publishing resources from a failed app startup. */
  static async resolve(
    client: WorkspaceClient,
    required = false,
  ): Promise<WarehouseBinding> {
    const warehouseId = required
      ? await discoverWarehouseId(client)
      : undefined;
    return Object.freeze({
      warehouseId:
        warehouseId === undefined ? undefined : Promise.resolve(warehouseId),
    });
  }

  /** Publish an immutable snapshot of resolved app resources. */
  static bind(bindings: WarehouseBinding): WarehouseBinding {
    appBinding = Object.freeze({ ...bindings });
    return appBinding;
  }

  static get(): WarehouseBinding | undefined {
    return appBinding;
  }

  /** Reset app bindings alongside the service context in tests. */
  static reset(): void {
    appBinding = undefined;
  }
}

async function discoverWarehouseId(client: WorkspaceClient): Promise<string> {
  if (process.env.DATABRICKS_WAREHOUSE_ID) {
    return process.env.DATABRICKS_WAREHOUSE_ID;
  }

  const agenticMode =
    process.env.DATABRICKS_APPS_AGENTIC_MODE === "true" ||
    process.env.DATABRICKS_APPS_AGENTIC_MODE === "1";

  if (process.env.NODE_ENV === "development" && !agenticMode) {
    const response = (await client.apiClient.request({
      path: "/api/2.0/sql/warehouses",
      method: "GET",
      headers: new Headers(),
      raw: false,
      query: { skip_cannot_use: "true" },
    })) as { warehouses: sql.EndpointInfo[] };

    const priorities: Record<sql.State, number> = {
      RUNNING: 0,
      STOPPED: 1,
      STARTING: 2,
      STOPPING: 3,
      DELETED: 99,
      DELETING: 99,
    };

    const warehouses = (response.warehouses || []).sort((a, b) => {
      return (
        priorities[a.state as sql.State] - priorities[b.state as sql.State]
      );
    });

    if (response.warehouses.length === 0) {
      throw ConfigurationError.resourceNotFound(
        "Warehouse ID",
        "Please configure the DATABRICKS_WAREHOUSE_ID environment variable",
      );
    }

    const firstWarehouse = warehouses[0];
    if (
      firstWarehouse.state === "DELETED" ||
      firstWarehouse.state === "DELETING" ||
      !firstWarehouse.id
    ) {
      throw ConfigurationError.resourceNotFound(
        "Warehouse ID",
        "Please configure the DATABRICKS_WAREHOUSE_ID environment variable",
      );
    }

    return firstWarehouse.id;
  }

  throw ConfigurationError.resourceNotFound(
    "Warehouse ID",
    "Please configure the DATABRICKS_WAREHOUSE_ID environment variable",
  );
}

// Only deprecated user-context overrides use this scope. New callers share app bindings.
const legacyResourceStorage = new AsyncLocalStorage<
  WarehouseBinding | undefined
>();

/** @internal Keep legacy resource overrides out of execution identity. */
export function runWithResourceBindings<T>(
  bindings: WarehouseBinding | undefined,
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
  const warehouseId = captureWarehouseId()();
  if (!warehouseId) {
    throw ConfigurationError.resourceNotFound(
      "Warehouse ID",
      "No plugin requires a SQL Warehouse. Add a sql_warehouse resource to your plugin manifest, or set DATABRICKS_WAREHOUSE_ID",
    );
  }
  return warehouseId;
}

/** Capture compatibility access now so it cannot drift into a later scope. */
export function captureWarehouseId(): () => Promise<string> | undefined {
  const binding = legacyResourceStorage.getStore() ?? WarehouseResource.get();
  return () => {
    if (!binding) {
      throw InitializationError.notInitialized(
        "WarehouseResource",
        "Call createApp() first",
      );
    }
    return binding.warehouseId;
  };
}
