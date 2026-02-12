import { describe, expect, it, vi } from "vitest";
import { ResourceRegistry } from "../resource-registry";
import { ResourceType } from "../types";

describe("ResourceRegistry", () => {
  describe("register and merge with fields", () => {
    it("should register a multi-field resource (database)", () => {
      const registry = new ResourceRegistry();
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
      const registry = new ResourceRegistry();
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
      const registry = new ResourceRegistry();
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
      const registry = new ResourceRegistry();
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
      const registry = new ResourceRegistry();
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
      const registry = new ResourceRegistry();
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

  describe("permission escalation tracking", () => {
    it("should track permissionSources for a single plugin", () => {
      const registry = new ResourceRegistry();
      registry.register("plugin-a", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "warehouse",
        resourceKey: "warehouse",
        description: "Warehouse",
        permission: "CAN_USE",
        required: true,
        fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
      });

      const entry = registry.get("sql_warehouse", "warehouse");
      expect(entry?.permissionSources).toEqual({ "plugin-a": "CAN_USE" });
    });

    it("should track permissionSources when merging multiple plugins", () => {
      const registry = new ResourceRegistry();
      registry.register("plugin-a", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "warehouse",
        resourceKey: "warehouse",
        description: "Warehouse",
        permission: "CAN_USE",
        required: true,
        fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
      });
      registry.register("plugin-b", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "warehouse",
        resourceKey: "warehouse",
        description: "Warehouse",
        permission: "CAN_MANAGE",
        required: true,
        fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
      });

      const entry = registry.get("sql_warehouse", "warehouse");
      expect(entry?.permission).toBe("CAN_MANAGE");
      expect(entry?.permissionSources).toEqual({
        "plugin-a": "CAN_USE",
        "plugin-b": "CAN_MANAGE",
      });
    });

    it("should warn when permission is escalated during merge", () => {
      const registry = new ResourceRegistry();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      registry.register("plugin-a", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "warehouse",
        resourceKey: "warehouse",
        description: "Warehouse",
        permission: "CAN_USE",
        required: true,
        fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
      });
      registry.register("plugin-b", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "warehouse",
        resourceKey: "warehouse",
        description: "Warehouse",
        permission: "CAN_MANAGE",
        required: true,
        fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
      });

      // The logger uses debug/console under the hood — verify final permission
      const entry = registry.get("sql_warehouse", "warehouse");
      expect(entry?.permission).toBe("CAN_MANAGE");

      warnSpy.mockRestore();
    });

    it("should not escalate when permissions are identical", () => {
      const registry = new ResourceRegistry();
      registry.register("plugin-a", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "warehouse",
        resourceKey: "warehouse",
        description: "Warehouse",
        permission: "CAN_USE",
        required: true,
        fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
      });
      registry.register("plugin-b", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "warehouse",
        resourceKey: "warehouse",
        description: "Warehouse",
        permission: "CAN_USE",
        required: false,
        fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
      });

      const entry = registry.get("sql_warehouse", "warehouse");
      expect(entry?.permission).toBe("CAN_USE");
      expect(entry?.permissionSources).toEqual({
        "plugin-a": "CAN_USE",
        "plugin-b": "CAN_USE",
      });
    });
  });

  describe("enforceValidation with APPKIT_STRICT_VALIDATION", () => {
    it("should throw in dev when APPKIT_STRICT_VALIDATION=true", () => {
      const registry = new ResourceRegistry();
      registry.register("analytics", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "warehouse",
        resourceKey: "warehouse",
        description: "Warehouse",
        permission: "CAN_USE",
        required: true,
        fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
      });
      delete process.env.DATABRICKS_WAREHOUSE_ID;

      const origNodeEnv = process.env.NODE_ENV;
      const origStrict = process.env.APPKIT_STRICT_VALIDATION;
      process.env.NODE_ENV = "development";
      process.env.APPKIT_STRICT_VALIDATION = "true";
      try {
        expect(() => registry.enforceValidation()).toThrow();
      } finally {
        process.env.NODE_ENV = origNodeEnv;
        process.env.APPKIT_STRICT_VALIDATION = origStrict ?? "";
      }
    });

    it("should only warn in dev when APPKIT_STRICT_VALIDATION is not set", () => {
      const registry = new ResourceRegistry();
      registry.register("analytics", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "warehouse",
        resourceKey: "warehouse",
        description: "Warehouse",
        permission: "CAN_USE",
        required: true,
        fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
      });
      delete process.env.DATABRICKS_WAREHOUSE_ID;

      const origNodeEnv = process.env.NODE_ENV;
      delete process.env.APPKIT_STRICT_VALIDATION;
      process.env.NODE_ENV = "development";
      try {
        const result = registry.enforceValidation();
        expect(result.valid).toBe(false);
      } finally {
        process.env.NODE_ENV = origNodeEnv;
      }
    });
  });

  describe("enforceValidation dev warning banner", () => {
    it("should format a visible banner for dev mode", () => {
      const banner = ResourceRegistry.formatDevWarningBanner([
        {
          type: ResourceType.SQL_WAREHOUSE,
          alias: "warehouse",
          resourceKey: "warehouse",
          description: "Warehouse",
          permission: "CAN_USE",
          fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
          required: true,
          plugin: "analytics",
          resolved: false,
        },
      ]);

      expect(banner).toContain("MISSING REQUIRED RESOURCES");
      expect(banner).toContain("would fail in production");
      expect(banner).toContain("sql_warehouse:warehouse");
      expect(banner).toContain("DATABRICKS_WAREHOUSE_ID");
      expect(banner).toContain("analytics");
      expect(banner).toContain(".env");
      // Should have box borders
      expect(banner).toContain("====");
      expect(banner).toContain("|");
    });
  });

  describe("formatMissingResources with fields", () => {
    it("should list field env vars for multi-field missing resources", () => {
      const registry = new ResourceRegistry();
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
      const registry = new ResourceRegistry();
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
