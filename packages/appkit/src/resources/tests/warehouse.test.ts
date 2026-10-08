import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ServiceContext } from "../../context/service-context";
import { ConfigurationError, InitializationError } from "../../errors";
import { getWarehouseId } from "../../index";
import { ResourceRegistry, ResourceType } from "../../registry";
import { createMockWorkspaceClient } from "../../testing/mock-workspace-client";
import { AppResources, type AppResourceBindings } from "../app-resources";
import { getConfiguredWarehouseId, WarehouseResource } from "../warehouse";

function warehouseRegistry(bindings: { env: string; required?: boolean }[]) {
  const registry = new ResourceRegistry();
  for (const { env, required = true } of bindings) {
    registry.register("custom", {
      type: ResourceType.SQL_WAREHOUSE,
      resourceKey: env,
      alias: "Query warehouse",
      description: "Test warehouse",
      permission: "CAN_USE",
      required,
      fields: { id: { env } },
    });
  }
  registry.validate();
  return registry;
}

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
    expect(client.request).not.toHaveBeenCalled();
    expect(getWarehouseId).toThrow(InitializationError);
    WarehouseResource.bind(bindings);
    expect(getWarehouseId()).toBe(bindings.warehouseId);
  });

  test("does not resolve a warehouse when no plugin requires it", async () => {
    vi.stubEnv("DATABRICKS_WAREHOUSE_ID", "unused-warehouse");
    const client = createMockWorkspaceClient();
    const bindings = await WarehouseResource.resolve(client);
    expect(bindings.warehouseId).toBeUndefined();
    expect(client.request).not.toHaveBeenCalled();
    WarehouseResource.bind(bindings);
    expect(getWarehouseId).toThrow(ConfigurationError);
    expect(getWarehouseId).toThrow("No plugin requires a SQL Warehouse");
  });

  test("uses the manifest binding instead of an unrelated default environment variable", async () => {
    vi.stubEnv("APPKIT_TEST_WAREHOUSE", "plugin-warehouse");
    vi.stubEnv("DATABRICKS_WAREHOUSE_ID", "unrelated-warehouse");
    const registry = warehouseRegistry([{ env: "APPKIT_TEST_WAREHOUSE" }]);
    const client = createMockWorkspaceClient();
    const binding = await WarehouseResource.resolve(
      client,
      getConfiguredWarehouseId(registry.getAll()),
    );
    WarehouseResource.bind(binding);
    expect(await getWarehouseId()).toBe("plugin-warehouse");
    expect(client.request).not.toHaveBeenCalled();
  });

  test("shares one ID across declarations with different environment variables", () => {
    vi.stubEnv("APPKIT_TEST_WAREHOUSE", "shared-warehouse");
    vi.stubEnv("APPKIT_TEST_OTHER_WAREHOUSE", "shared-warehouse");
    const registry = warehouseRegistry([
      { env: "APPKIT_TEST_WAREHOUSE" },
      { env: "APPKIT_TEST_OTHER_WAREHOUSE" },
    ]);
    expect(getConfiguredWarehouseId(registry.getAll())).toBe(
      "shared-warehouse",
    );
  });

  test("requires an explicit app default when manifest bindings differ", () => {
    vi.stubEnv("DATABRICKS_WAREHOUSE_ID", "");
    vi.stubEnv("APPKIT_TEST_WAREHOUSE", "first-warehouse");
    vi.stubEnv("APPKIT_TEST_OTHER_WAREHOUSE", "second-warehouse");
    const registry = warehouseRegistry([
      { env: "APPKIT_TEST_WAREHOUSE" },
      { env: "APPKIT_TEST_OTHER_WAREHOUSE" },
    ]);
    expect(() => getConfiguredWarehouseId(registry.getAll())).toThrow(
      "Multiple SQL warehouses are configured. Set DATABRICKS_WAREHOUSE_ID",
    );
    vi.stubEnv("DATABRICKS_WAREHOUSE_ID", "second-warehouse");
    expect(getConfiguredWarehouseId(registry.getAll())).toBe(
      "second-warehouse",
    );
  });

  test("leaves missing bindings to discovery and does not activate optional warehouses", () => {
    vi.stubEnv("APPKIT_TEST_WAREHOUSE", "");
    vi.stubEnv("APPKIT_TEST_OTHER_WAREHOUSE", "optional-warehouse");
    const registry = warehouseRegistry([
      { env: "APPKIT_TEST_WAREHOUSE" },
      { env: "APPKIT_TEST_OTHER_WAREHOUSE", required: false },
    ]);
    expect(getConfiguredWarehouseId(registry.getAll())).toBeUndefined();
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
  // Databricks list APIs omit empty arrays (`warehouses` is `omitempty`), so
  // dev discovery must treat a missing key like an empty list.
  test.each([
    { name: "omitted warehouses key", response: {} },
    { name: "empty warehouses list", response: { warehouses: [] } },
  ])(
    "dev discovery reports a missing warehouse for $name",
    async ({ response }) => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("DATABRICKS_WAREHOUSE_ID", "");
      vi.stubEnv("DATABRICKS_APPS_AGENTIC_MODE", "");
      const client = createMockWorkspaceClient();
      vi.mocked(client.request).mockResolvedValue(
        new Response(JSON.stringify(response)),
      );
      const error = await WarehouseResource.resolve(client, true).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).not.toBeInstanceOf(TypeError);
      expect(client.request).toHaveBeenCalledTimes(1);
    },
  );
});
