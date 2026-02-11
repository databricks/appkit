import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResourceRegistry } from "../resource-registry";
import { ResourceType } from "../types";

describe("ResourceRegistry", () => {
  beforeEach(() => {
    ResourceRegistry.resetInstance();
  });

  afterEach(() => {
    ResourceRegistry.resetInstance();
  });

  describe("register and merge with fields", () => {
    it("should register a multi-field resource (database)", () => {
      const registry = ResourceRegistry.getInstance();
      registry.register("analytics", {
        type: ResourceType.DATABASE,
        alias: "cache",
        resourceKey: "cache",
        description: "Database for caching",
        permission: "CAN_CONNECT_AND_CREATE",
        required: true,
        fields: {
          instance_name: {
            env: "DATABRICKS_CACHE_INSTANCE",
            description: "Lakebase instance name",
          },
          database_name: {
            env: "DATABRICKS_CACHE_DB",
            description: "Database name",
          },
        },
      });

      const entry = registry.get("database", "cache");
      expect(entry).toBeDefined();
      expect(entry?.fields).toEqual({
        instance_name: {
          env: "DATABRICKS_CACHE_INSTANCE",
          description: "Lakebase instance name",
        },
        database_name: {
          env: "DATABRICKS_CACHE_DB",
          description: "Database name",
        },
      });
    });

    it("should merge resources and prefer existing fields", () => {
      const registry = ResourceRegistry.getInstance();
      registry.register("plugin-a", {
        type: ResourceType.SECRET,
        alias: "creds",
        resourceKey: "creds",
        description: "Credentials",
        permission: "READ",
        required: true,
        fields: {
          scope: { env: "SECRET_SCOPE_A", description: "Scope" },
          key: { env: "SECRET_KEY_A", description: "Key" },
        },
      });
      registry.register("plugin-b", {
        type: ResourceType.SECRET,
        alias: "creds",
        resourceKey: "creds",
        description: "Credentials",
        permission: "READ",
        required: false,
        fields: {
          scope: { env: "SECRET_SCOPE_B", description: "Scope" },
          key: { env: "SECRET_KEY_B", description: "Key" },
        },
      });

      const entry = registry.get("secret", "creds");
      expect(entry?.fields).toEqual({
        scope: { env: "SECRET_SCOPE_A", description: "Scope" },
        key: { env: "SECRET_KEY_A", description: "Key" },
      });
      expect(entry?.plugin).toContain("plugin-a");
      expect(entry?.plugin).toContain("plugin-b");
    });

    it("should merge single-value resources (fields with one key)", () => {
      const registry = ResourceRegistry.getInstance();
      registry.register("plugin-a", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "warehouse",
        resourceKey: "warehouse",
        description: "Warehouse",
        permission: "CAN_USE",
        required: true,
        fields: {
          id: { env: "DATABRICKS_WAREHOUSE_ID", description: "Warehouse ID" },
        },
      });
      registry.register("plugin-b", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "warehouse",
        resourceKey: "warehouse",
        description: "Warehouse",
        permission: "CAN_USE",
        required: false,
        fields: {
          id: { env: "DATABRICKS_WAREHOUSE_ID", description: "Warehouse ID" },
        },
      });

      const entry = registry.get("sql_warehouse", "warehouse");
      expect(entry?.fields).toEqual({
        id: { env: "DATABRICKS_WAREHOUSE_ID", description: "Warehouse ID" },
      });
    });
  });

  describe("validate with fields", () => {
    const CACHE_INSTANCE = "DATABRICKS_CACHE_INSTANCE";
    const CACHE_DB = "DATABRICKS_CACHE_DB";

    it("should resolve multi-field resource when all env vars are set", () => {
      const registry = ResourceRegistry.getInstance();
      registry.register("analytics", {
        type: ResourceType.DATABASE,
        alias: "cache",
        resourceKey: "cache",
        description: "Cache database",
        permission: "CAN_CONNECT_AND_CREATE",
        required: true,
        fields: {
          instance_name: { env: CACHE_INSTANCE },
          database_name: { env: CACHE_DB },
        },
      });

      const orig = process.env[CACHE_INSTANCE];
      const origDb = process.env[CACHE_DB];
      process.env[CACHE_INSTANCE] = "my-instance";
      process.env[CACHE_DB] = "my_db";
      try {
        const result = registry.validate();
        expect(result.valid).toBe(true);
        expect(result.missing).toHaveLength(0);
        const entry = registry.get("database", "cache");
        expect(entry?.resolved).toBe(true);
        expect(entry?.values).toEqual({
          instance_name: "my-instance",
          database_name: "my_db",
        });
      } finally {
        if (orig !== undefined) process.env[CACHE_INSTANCE] = orig;
        else delete process.env[CACHE_INSTANCE];
        if (origDb !== undefined) process.env[CACHE_DB] = origDb;
        else delete process.env[CACHE_DB];
      }
    });

    it("should mark multi-field resource missing when any env var is unset", () => {
      const registry = ResourceRegistry.getInstance();
      registry.register("analytics", {
        type: ResourceType.DATABASE,
        alias: "cache",
        resourceKey: "cache",
        description: "Cache database",
        permission: "CAN_CONNECT_AND_CREATE",
        required: true,
        fields: {
          instance_name: { env: CACHE_INSTANCE },
          database_name: { env: CACHE_DB },
        },
      });

      delete process.env[CACHE_INSTANCE];
      delete process.env[CACHE_DB];

      const result = registry.validate();
      expect(result.valid).toBe(false);
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0].type).toBe("database");
      expect(result.missing[0].alias).toBe("cache");
      const entry = registry.get("database", "cache");
      expect(entry?.resolved).toBe(false);
      expect(entry?.values).toBeUndefined();
    });

    it("should mark multi-field resource missing when only one env var is set", () => {
      const registry = ResourceRegistry.getInstance();
      registry.register("analytics", {
        type: ResourceType.DATABASE,
        alias: "cache",
        resourceKey: "cache",
        description: "Cache database",
        permission: "CAN_CONNECT_AND_CREATE",
        required: true,
        fields: {
          instance_name: { env: CACHE_INSTANCE },
          database_name: { env: CACHE_DB },
        },
      });

      process.env[CACHE_INSTANCE] = "my-instance";
      delete process.env[CACHE_DB];

      const result = registry.validate();
      expect(result.valid).toBe(false);
      expect(result.missing).toHaveLength(1);
      const entry = registry.get("database", "cache");
      expect(entry?.resolved).toBe(false);
      expect(entry?.values).toEqual({ instance_name: "my-instance" });
    });
  });

  describe("formatMissingResources with fields", () => {
    it("should list field env vars for multi-field missing resources", () => {
      const registry = ResourceRegistry.getInstance();
      registry.register("analytics", {
        type: ResourceType.SECRET,
        alias: "creds",
        resourceKey: "creds",
        description: "Credentials",
        permission: "READ",
        required: true,
        fields: {
          scope: { env: "SECRET_SCOPE" },
          key: { env: "SECRET_KEY" },
        },
      });

      delete process.env.SECRET_SCOPE;
      delete process.env.SECRET_KEY;
      const result = registry.validate();
      expect(result.valid).toBe(false);

      const formatted = ResourceRegistry.formatMissingResources(result.missing);
      expect(formatted).toContain("secret:creds");
      expect(formatted).toContain("SECRET_SCOPE");
      expect(formatted).toContain("SECRET_KEY");
    });

    it("should list field env vars for single-value missing resources", () => {
      const registry = ResourceRegistry.getInstance();
      registry.register("analytics", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "warehouse",
        resourceKey: "warehouse",
        description: "Warehouse",
        permission: "CAN_USE",
        required: true,
        fields: {
          id: { env: "DATABRICKS_WAREHOUSE_ID", description: "Warehouse ID" },
        },
      });

      delete process.env.DATABRICKS_WAREHOUSE_ID;
      const result = registry.validate();
      const formatted = ResourceRegistry.formatMissingResources(result.missing);
      expect(formatted).toContain("DATABRICKS_WAREHOUSE_ID");
    });
  });
});
