import { warnContextDeprecation } from "../context/deprecation";
import { InitializationError } from "../errors";
import type { WorkspaceClient } from "../workspace-client";
import { WarehouseResource, type WarehouseBinding } from "./warehouse";

/** @deprecated Use WarehouseBinding. Retained for backward compatibility. */
export type AppResourceBindings = WarehouseBinding;

/** @deprecated Use WarehouseResource. Retained for backward compatibility. */
export class AppResources {
  static resolve(
    client: WorkspaceClient,
    options?: { warehouseId?: boolean },
  ): Promise<AppResourceBindings> {
    warnContextDeprecation("AppResources.resolve", "WarehouseResource.resolve");
    return WarehouseResource.resolve(client, options?.warehouseId);
  }

  static bind(bindings: AppResourceBindings): AppResourceBindings {
    warnContextDeprecation("AppResources.bind", "WarehouseResource.bind");
    return WarehouseResource.bind(bindings);
  }

  static get(): AppResourceBindings {
    warnContextDeprecation("AppResources.get", "WarehouseResource.get");
    const binding = WarehouseResource.get();
    if (!binding) {
      throw InitializationError.notInitialized(
        "AppResources",
        "Call createApp() first",
      );
    }
    return binding;
  }

  static reset(): void {
    warnContextDeprecation("AppResources.reset", "WarehouseResource.reset");
    WarehouseResource.reset();
  }
}
