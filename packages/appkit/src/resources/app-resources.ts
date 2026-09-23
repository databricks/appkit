import { ConfigurationError, InitializationError } from "../errors";
import type { sql, WorkspaceClient } from "../workspace-client";

/** App-level resource bindings, separate from execution identity. */
export interface AppResourceBindings {
  readonly warehouseId?: Promise<string>;
}

/** Owns the shared bindings for the current app lifecycle. */
export class AppResources {
  private static bindings: AppResourceBindings | undefined;

  /** Resolve candidates without publishing resources from a failed app startup. */
  static async resolve(
    client: WorkspaceClient,
    options?: { warehouseId?: boolean },
  ): Promise<AppResourceBindings> {
    const warehouseId = options?.warehouseId
      ? await discoverWarehouseId(client)
      : undefined;
    return Object.freeze({
      warehouseId:
        warehouseId === undefined ? undefined : Promise.resolve(warehouseId),
    });
  }

  /** Publish an immutable snapshot of resolved app resources. */
  static bind(bindings: AppResourceBindings): AppResourceBindings {
    AppResources.bindings = Object.freeze({ ...bindings });
    return AppResources.bindings;
  }

  static get(): AppResourceBindings {
    if (!AppResources.bindings) {
      throw InitializationError.notInitialized(
        "AppResources",
        "Call createApp() first",
      );
    }
    return AppResources.bindings;
  }

  /** Reset app bindings alongside the service context in tests. */
  static reset(): void {
    AppResources.bindings = undefined;
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
