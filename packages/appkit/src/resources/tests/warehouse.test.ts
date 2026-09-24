import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ServiceContext } from "../../context/service-context";
import { ConfigurationError, InitializationError } from "../../errors";
import { getWarehouseId } from "../../index";
import { createMockWorkspaceClient } from "../../testing/mock-workspace-client";
import { AppResources, type AppResourceBindings } from "../app-resources";
import { WarehouseResource } from "../warehouse";

describe("warehouse resource bindings", () => {
  beforeEach(() => {
    WarehouseResource.reset();
  });

  afterEach(() => {
    WarehouseResource.reset();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("the public accessor requires initialized resources", () => {
    expect(getWarehouseId).toThrow(InitializationError);
  });

  test("reads the resource binding without consulting service identity", () => {
    const warehouseId = Promise.resolve("resource-warehouse");
    WarehouseResource.bind({ warehouseId });
    const getService = vi
      .spyOn(ServiceContext, "get")
      .mockImplementation(() => {
        throw new Error("Service identity is not available");
      });
    expect(getWarehouseId()).toBe(warehouseId);
    expect(getService).not.toHaveBeenCalled();
  });

  test("freezes a resource snapshot without freezing its input", () => {
    const warehouseId = Promise.resolve("original");
    const input = { warehouseId };
    const bindings = WarehouseResource.bind(input);
    input.warehouseId = Promise.resolve("changed");
    expect(Object.isFrozen(bindings)).toBe(true);
    expect(Reflect.set(bindings, "warehouseId", input.warehouseId)).toBe(false);
    expect(getWarehouseId()).toBe(warehouseId);
  });

  test("resolves the environment binding without publishing it", async () => {
    vi.stubEnv("DATABRICKS_WAREHOUSE_ID", "configured-warehouse");
    const client = createMockWorkspaceClient();
    const bindings = await WarehouseResource.resolve(client, true);
    expect(await bindings.warehouseId).toBe("configured-warehouse");
    expect(client.apiClient.request).not.toHaveBeenCalled();
    expect(getWarehouseId).toThrow(InitializationError);
    WarehouseResource.bind(bindings);
    expect(getWarehouseId()).toBe(bindings.warehouseId);
  });

  test("does not resolve a warehouse when no plugin requires it", async () => {
    vi.stubEnv("DATABRICKS_WAREHOUSE_ID", "unused-warehouse");
    const client = createMockWorkspaceClient();
    const bindings = await WarehouseResource.resolve(client);
    expect(bindings.warehouseId).toBeUndefined();
    expect(client.apiClient.request).not.toHaveBeenCalled();
    WarehouseResource.bind(bindings);
    expect(getWarehouseId).toThrow(ConfigurationError);
    expect(getWarehouseId).toThrow("No plugin requires a SQL Warehouse");
  });

  test("deprecated resource names delegate to the warehouse module and warn once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("DATABRICKS_WAREHOUSE_ID", "compat-warehouse");
    const client = createMockWorkspaceClient();
    for (let i = 0; i < 2; i++) {
      expect(() => AppResources.get()).toThrow(InitializationError);
      const binding: AppResourceBindings = await AppResources.resolve(client, {
        warehouseId: true,
      });
      expect(AppResources.bind(binding)).toBe(WarehouseResource.get());
      expect(AppResources.get()).toBe(WarehouseResource.get());
      expect(await getWarehouseId()).toBe("compat-warehouse");
      AppResources.reset();
      expect(getWarehouseId).toThrow(InitializationError);
    }
    for (const method of ["resolve", "bind", "get", "reset"]) {
      expect(
        warn.mock.calls.filter((args) =>
          args.includes(
            `AppResources.${method} is deprecated. Use WarehouseResource.${method} instead.`,
          ),
        ),
      ).toHaveLength(1);
    }
  });
});
