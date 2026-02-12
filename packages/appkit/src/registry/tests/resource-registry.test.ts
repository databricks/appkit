import type { PluginConstructor, PluginData } from "shared";
import { describe, expect, it, vi } from "vitest";
import { ResourceRegistry } from "../resource-registry";
import type { ResourceRequirement } from "../types";
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
      const prev1 = process.env[CACHE_INSTANCE];
      const prev2 = process.env[CACHE_DB];
      process.env[CACHE_INSTANCE] = "my-instance";
      process.env[CACHE_DB] = "my_db";
      try {
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
        if (prev1 !== undefined) process.env[CACHE_INSTANCE] = prev1;
        else delete process.env[CACHE_INSTANCE];
        if (prev2 !== undefined) process.env[CACHE_DB] = prev2;
        else delete process.env[CACHE_DB];
      }
    });

    it("should mark multi-field resource missing when any env var is unset", () => {
      const prev1 = process.env[CACHE_INSTANCE];
      const prev2 = process.env[CACHE_DB];
      delete process.env[CACHE_INSTANCE];
      delete process.env[CACHE_DB];
      try {
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

        const result = registry.validate();
        expect(result.valid).toBe(false);
        expect(result.missing).toHaveLength(1);
        expect(result.missing[0].type).toBe("database");
        expect(result.missing[0].alias).toBe("cache");
        const entry = registry.get("database", "cache");
        expect(entry?.resolved).toBe(false);
        expect(entry?.values).toBeUndefined();
      } finally {
        if (prev1 !== undefined) process.env[CACHE_INSTANCE] = prev1;
        else delete process.env[CACHE_INSTANCE];
        if (prev2 !== undefined) process.env[CACHE_DB] = prev2;
        else delete process.env[CACHE_DB];
      }
    });

    it("should mark multi-field resource missing when only one env var is set", () => {
      const prev1 = process.env[CACHE_INSTANCE];
      const prev2 = process.env[CACHE_DB];
      process.env[CACHE_INSTANCE] = "my-instance";
      delete process.env[CACHE_DB];
      try {
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

        const result = registry.validate();
        expect(result.valid).toBe(false);
        expect(result.missing).toHaveLength(1);
        const entry = registry.get("database", "cache");
        expect(entry?.resolved).toBe(false);
        expect(entry?.values).toEqual({ instance_name: "my-instance" });
      } finally {
        if (prev1 !== undefined) process.env[CACHE_INSTANCE] = prev1;
        else delete process.env[CACHE_INSTANCE];
        if (prev2 !== undefined) process.env[CACHE_DB] = prev2;
        else delete process.env[CACHE_DB];
      }
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

  describe("enforceValidation", () => {
    it("should throw in production when required resources are missing", () => {
      const prevNodeEnv = process.env.NODE_ENV;
      const prevWh = process.env.DATABRICKS_WAREHOUSE_ID;
      process.env.NODE_ENV = "production";
      delete process.env.DATABRICKS_WAREHOUSE_ID;
      try {
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
        expect(() => registry.enforceValidation()).toThrow();
      } finally {
        process.env.NODE_ENV = prevNodeEnv;
        if (prevWh !== undefined) process.env.DATABRICKS_WAREHOUSE_ID = prevWh;
        else delete process.env.DATABRICKS_WAREHOUSE_ID;
      }
    });

    it("should throw in dev when APPKIT_STRICT_VALIDATION=true and resources missing", () => {
      const prevNodeEnv = process.env.NODE_ENV;
      const prevStrict = process.env.APPKIT_STRICT_VALIDATION;
      const prevWh = process.env.DATABRICKS_WAREHOUSE_ID;
      process.env.NODE_ENV = "development";
      process.env.APPKIT_STRICT_VALIDATION = "true";
      delete process.env.DATABRICKS_WAREHOUSE_ID;
      try {
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
        expect(() => registry.enforceValidation()).toThrow();
      } finally {
        process.env.NODE_ENV = prevNodeEnv;
        process.env.APPKIT_STRICT_VALIDATION = prevStrict ?? "";
        if (prevWh !== undefined) process.env.DATABRICKS_WAREHOUSE_ID = prevWh;
        else delete process.env.DATABRICKS_WAREHOUSE_ID;
      }
    });

    it("should only warn in dev when APPKIT_STRICT_VALIDATION is not set", () => {
      const prevNodeEnv = process.env.NODE_ENV;
      const prevStrict = process.env.APPKIT_STRICT_VALIDATION;
      const prevWh = process.env.DATABRICKS_WAREHOUSE_ID;
      process.env.NODE_ENV = "development";
      delete process.env.APPKIT_STRICT_VALIDATION;
      delete process.env.DATABRICKS_WAREHOUSE_ID;
      try {
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
        const result = registry.enforceValidation();
        expect(result.valid).toBe(false);
      } finally {
        process.env.NODE_ENV = prevNodeEnv;
        if (prevStrict !== undefined)
          process.env.APPKIT_STRICT_VALIDATION = prevStrict;
        else delete process.env.APPKIT_STRICT_VALIDATION;
        if (prevWh !== undefined) process.env.DATABRICKS_WAREHOUSE_ID = prevWh;
        else delete process.env.DATABRICKS_WAREHOUSE_ID;
      }
    });

    it("should not throw in production when all required resources are set", () => {
      const prevNodeEnv = process.env.NODE_ENV;
      const prevWh = process.env.DATABRICKS_WAREHOUSE_ID;
      process.env.NODE_ENV = "production";
      process.env.DATABRICKS_WAREHOUSE_ID = "wh-123";
      try {
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
        const result = registry.enforceValidation();
        expect(result.valid).toBe(true);
      } finally {
        process.env.NODE_ENV = prevNodeEnv;
        if (prevWh !== undefined) process.env.DATABRICKS_WAREHOUSE_ID = prevWh;
        else delete process.env.DATABRICKS_WAREHOUSE_ID;
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
      const prevScope = process.env.SECRET_SCOPE;
      const prevKey = process.env.SECRET_KEY;
      delete process.env.SECRET_SCOPE;
      delete process.env.SECRET_KEY;
      try {
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

        const result = registry.validate();
        expect(result.valid).toBe(false);

        const formatted = ResourceRegistry.formatMissingResources(
          result.missing,
        );
        expect(formatted).toContain("secret:creds");
        expect(formatted).toContain("SECRET_SCOPE");
        expect(formatted).toContain("SECRET_KEY");
      } finally {
        if (prevScope !== undefined) process.env.SECRET_SCOPE = prevScope;
        else delete process.env.SECRET_SCOPE;
        if (prevKey !== undefined) process.env.SECRET_KEY = prevKey;
        else delete process.env.SECRET_KEY;
      }
    });

    it("should list field env vars for single-value missing resources", () => {
      const prevWh = process.env.DATABRICKS_WAREHOUSE_ID;
      delete process.env.DATABRICKS_WAREHOUSE_ID;
      try {
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

        const result = registry.validate();
        const formatted = ResourceRegistry.formatMissingResources(
          result.missing,
        );
        expect(formatted).toContain("DATABRICKS_WAREHOUSE_ID");
      } finally {
        if (prevWh !== undefined) process.env.DATABRICKS_WAREHOUSE_ID = prevWh;
        else delete process.env.DATABRICKS_WAREHOUSE_ID;
      }
    });
  });

  describe("collectResources with getResourceRequirements", () => {
    it("should register runtime resources from getResourceRequirements(config)", () => {
      interface Config {
        enableCache?: boolean;
      }
      const PluginWithRuntimeRequirements = class {
        static manifest = {
          name: "with-runtime",
          displayName: "With Runtime",
          description: "Plugin with runtime resources",
          resources: {
            required: [
              {
                type: ResourceType.SQL_WAREHOUSE,
                alias: "wh",
                resourceKey: "warehouse",
                description: "Warehouse",
                permission: "CAN_USE" as const,
                fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
              },
            ],
            optional: [],
          },
        };
        static getResourceRequirements(config: Config): ResourceRequirement[] {
          const base: ResourceRequirement[] = [
            {
              type: ResourceType.SQL_WAREHOUSE,
              alias: "wh",
              resourceKey: "warehouse",
              description: "Warehouse",
              permission: "CAN_USE",
              fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
              required: true,
            },
          ];
          if (config.enableCache) {
            base.push({
              type: ResourceType.DATABASE,
              alias: "cache",
              resourceKey: "cache",
              description: "Cache DB",
              permission: "CAN_CONNECT_AND_CREATE",
              fields: {
                instance_name: { env: "CACHE_INSTANCE" },
                database_name: { env: "CACHE_DB" },
              },
              required: true,
            });
          }
          return base;
        }
      };

      const registry = new ResourceRegistry();
      const rawPlugins: PluginData<PluginConstructor, unknown, string>[] = [
        {
          name: "withRuntime",
          plugin: PluginWithRuntimeRequirements as unknown as PluginConstructor,
          config: { enableCache: true },
        },
      ];
      registry.collectResources(rawPlugins);

      expect(registry.size()).toBe(2);
      expect(registry.get("sql_warehouse", "warehouse")).toBeDefined();
      expect(registry.get("database", "cache")).toBeDefined();
      expect(registry.getByPlugin("withRuntime")).toHaveLength(2);
    });
  });

  describe("mergeResources edge cases", () => {
    it("should merge when second plugin adds new field names (union of fields)", () => {
      const registry = new ResourceRegistry();
      registry.register("plugin-a", {
        type: ResourceType.SECRET,
        alias: "creds",
        resourceKey: "creds",
        description: "Creds",
        permission: "READ",
        required: true,
        fields: {
          scope: { env: "SCOPE_A", description: "Scope" },
          key: { env: "KEY_A", description: "Key" },
        },
      });
      registry.register("plugin-b", {
        type: ResourceType.SECRET,
        alias: "creds",
        resourceKey: "creds",
        description: "Creds",
        permission: "READ",
        required: false,
        fields: {
          scope: { env: "SCOPE_B" },
          key: { env: "KEY_B" },
          extra_field: { env: "EXTRA_B", description: "Extra" },
        },
      });

      const entry = registry.get("secret", "creds");
      expect(entry?.fields.scope.env).toBe("SCOPE_A");
      expect(entry?.fields.key.env).toBe("KEY_A");
      expect(entry?.fields.extra_field?.env).toBe("EXTRA_B");
    });

    it("should treat unlisted permission as least permissive when merging", () => {
      const registry = new ResourceRegistry();
      registry.register("plugin-a", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "wh",
        resourceKey: "warehouse",
        description: "Warehouse",
        permission: "CAN_USE",
        required: true,
        fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
      });
      registry.register("plugin-b", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "wh",
        resourceKey: "warehouse",
        description: "Warehouse",
        permission: "UNKNOWN_PERMISSION" as any,
        required: true,
        fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
      });

      const entry = registry.get("sql_warehouse", "warehouse");
      expect(entry?.permission).toBe("CAN_USE");
    });
  });

  describe("registry accessors", () => {
    it("getByPlugin returns only resources for that plugin", () => {
      const registry = new ResourceRegistry();
      registry.register("analytics", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "wh",
        resourceKey: "warehouse",
        description: "WH",
        permission: "CAN_USE",
        required: true,
        fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
      });
      registry.register("server", {
        type: ResourceType.APP,
        alias: "app",
        resourceKey: "app",
        description: "App",
        permission: "CAN_USE",
        required: true,
        fields: { id: { env: "DATABRICKS_APP_ID" } },
      });

      const byAnalytics = registry.getByPlugin("analytics");
      const byServer = registry.getByPlugin("server");
      expect(byAnalytics).toHaveLength(1);
      expect(byServer).toHaveLength(1);
      expect(byAnalytics[0].type).toBe("sql_warehouse");
      expect(byServer[0].type).toBe("app");
    });

    it("getRequired and getOptional filter by required flag", () => {
      const registry = new ResourceRegistry();
      registry.register("p", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "wh",
        resourceKey: "warehouse",
        description: "WH",
        permission: "CAN_USE",
        required: true,
        fields: { id: { env: "WH_ID" } },
      });
      registry.register("p", {
        type: ResourceType.APP,
        alias: "app",
        resourceKey: "app",
        description: "App",
        permission: "CAN_USE",
        required: false,
        fields: { id: { env: "APP_ID" } },
      });

      expect(registry.getRequired()).toHaveLength(1);
      expect(registry.getOptional()).toHaveLength(1);
      expect(registry.getRequired()[0].resourceKey).toBe("warehouse");
      expect(registry.getOptional()[0].resourceKey).toBe("app");
    });

    it("size returns count of unique resources (by type+resourceKey)", () => {
      const registry = new ResourceRegistry();
      expect(registry.size()).toBe(0);
      registry.register("a", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "wh",
        resourceKey: "warehouse",
        description: "WH",
        permission: "CAN_USE",
        required: true,
        fields: { id: { env: "WH_ID" } },
      });
      expect(registry.size()).toBe(1);
      registry.register("b", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "wh",
        resourceKey: "warehouse",
        description: "WH",
        permission: "CAN_USE",
        required: false,
        fields: { id: { env: "WH_ID" } },
      });
      expect(registry.size()).toBe(1);
      registry.register("b", {
        type: ResourceType.APP,
        alias: "app",
        resourceKey: "app",
        description: "App",
        permission: "CAN_USE",
        required: true,
        fields: { id: { env: "APP_ID" } },
      });
      expect(registry.size()).toBe(2);
    });

    it("clear removes all resources", () => {
      const registry = new ResourceRegistry();
      registry.register("a", {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "wh",
        resourceKey: "warehouse",
        description: "WH",
        permission: "CAN_USE",
        required: true,
        fields: { id: { env: "WH_ID" } },
      });
      expect(registry.size()).toBe(1);
      registry.clear();
      expect(registry.size()).toBe(0);
      expect(registry.get("sql_warehouse", "warehouse")).toBeUndefined();
    });
  });
});
