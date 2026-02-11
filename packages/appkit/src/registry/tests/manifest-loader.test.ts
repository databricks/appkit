import type { PluginConstructor } from "shared";
import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../errors";
import {
  getPluginManifest,
  getResourceRequirements,
  isValidManifest,
} from "../manifest-loader";
import type { PluginManifest } from "../types";
import { ResourceType } from "../types";

describe("Manifest Loader", () => {
  describe("getPluginManifest", () => {
    it("should return manifest for plugin with valid manifest", () => {
      const mockManifest: PluginManifest = {
        name: "test-plugin",
        displayName: "Test Plugin",
        description: "A test plugin",
        resources: {
          required: [
            {
              type: ResourceType.SQL_WAREHOUSE,
              alias: "warehouse",
              resourceKey: "sql-warehouse",
              description: "Test warehouse",
              permission: "CAN_USE",
              fields: {
                id: { env: "TEST_WAREHOUSE_ID", description: "Warehouse ID" },
              },
            },
          ],
          optional: [],
        },
      };

      class TestPlugin {
        static manifest = mockManifest;
      }

      const result = getPluginManifest(
        TestPlugin as unknown as PluginConstructor,
      );
      expect(result).toEqual(mockManifest);
    });

    it("should throw error for plugin without manifest", () => {
      class PluginWithoutManifest {}

      expect(() =>
        getPluginManifest(
          PluginWithoutManifest as unknown as PluginConstructor,
        ),
      ).toThrow(ConfigurationError);
      expect(() =>
        getPluginManifest(
          PluginWithoutManifest as unknown as PluginConstructor,
        ),
      ).toThrow(/missing a manifest/i);
    });

    it("should throw error for plugin with invalid manifest (missing name)", () => {
      const invalidManifest = {
        displayName: "Test Plugin",
        description: "A test plugin",
        resources: {
          required: [],
          optional: [],
        },
      };

      class InvalidPlugin {
        static manifest = invalidManifest;
      }

      expect(() =>
        getPluginManifest(InvalidPlugin as unknown as PluginConstructor),
      ).toThrow(ConfigurationError);
      expect(() =>
        getPluginManifest(InvalidPlugin as unknown as PluginConstructor),
      ).toThrow(/invalid 'name' field/i);
    });

    it("should throw error for plugin with invalid manifest (missing displayName)", () => {
      const invalidManifest = {
        name: "test-plugin",
        description: "A test plugin",
        resources: {
          required: [],
          optional: [],
        },
      };

      class InvalidPlugin {
        static manifest = invalidManifest;
      }

      expect(() =>
        getPluginManifest(InvalidPlugin as unknown as PluginConstructor),
      ).toThrow(ConfigurationError);
      expect(() =>
        getPluginManifest(InvalidPlugin as unknown as PluginConstructor),
      ).toThrow(/invalid 'displayName' field/i);
    });

    it("should throw error for plugin with invalid manifest (missing description)", () => {
      const invalidManifest = {
        name: "test-plugin",
        displayName: "Test Plugin",
        resources: {
          required: [],
          optional: [],
        },
      };

      class InvalidPlugin {
        static manifest = invalidManifest;
      }

      expect(() =>
        getPluginManifest(InvalidPlugin as unknown as PluginConstructor),
      ).toThrow(ConfigurationError);
      expect(() =>
        getPluginManifest(InvalidPlugin as unknown as PluginConstructor),
      ).toThrow(/invalid 'description' field/i);
    });

    it("should throw error for plugin with invalid manifest (missing resources)", () => {
      const invalidManifest = {
        name: "test-plugin",
        displayName: "Test Plugin",
        description: "A test plugin",
      };

      class InvalidPlugin {
        static manifest = invalidManifest;
      }

      expect(() =>
        getPluginManifest(InvalidPlugin as unknown as PluginConstructor),
      ).toThrow(ConfigurationError);
      expect(() =>
        getPluginManifest(InvalidPlugin as unknown as PluginConstructor),
      ).toThrow(/missing 'resources' field/i);
    });

    it("should throw error for plugin with invalid manifest (resources.required not array)", () => {
      const invalidManifest = {
        name: "test-plugin",
        displayName: "Test Plugin",
        description: "A test plugin",
        resources: {
          required: "not-an-array",
          optional: [],
        },
      };

      class InvalidPlugin {
        static manifest = invalidManifest;
      }

      expect(() =>
        getPluginManifest(InvalidPlugin as unknown as PluginConstructor),
      ).toThrow(ConfigurationError);
      expect(() =>
        getPluginManifest(InvalidPlugin as unknown as PluginConstructor),
      ).toThrow(/invalid 'resources.required' field/i);
    });

    it("should throw error for plugin with invalid manifest (resources.optional not array)", () => {
      const invalidManifest = {
        name: "test-plugin",
        displayName: "Test Plugin",
        description: "A test plugin",
        resources: {
          required: [],
          optional: "not-an-array",
        },
      };

      class InvalidPlugin {
        static manifest = invalidManifest;
      }

      expect(() =>
        getPluginManifest(InvalidPlugin as unknown as PluginConstructor),
      ).toThrow(ConfigurationError);
      expect(() =>
        getPluginManifest(InvalidPlugin as unknown as PluginConstructor),
      ).toThrow(/invalid 'resources.optional' field/i);
    });

    it("should handle plugin with optional resources", () => {
      const mockManifest: PluginManifest = {
        name: "test-plugin",
        displayName: "Test Plugin",
        description: "A test plugin",
        resources: {
          required: [],
          optional: [
            {
              type: ResourceType.SECRET,
              alias: "Secret",
              resourceKey: "secret",
              description: "Optional secrets",
              permission: "READ",
              fields: {
                scope: { env: "TEST_SECRET_SCOPE" },
                key: { env: "TEST_SECRET_KEY" },
              },
            },
          ],
        },
      };

      class TestPlugin {
        static manifest = mockManifest;
      }

      const result = getPluginManifest(
        TestPlugin as unknown as PluginConstructor,
      );
      expect(result).toEqual(mockManifest);
    });
  });

  describe("getResourceRequirements", () => {
    it("should throw error for plugin without manifest", () => {
      class PluginWithoutManifest {}

      expect(() =>
        getResourceRequirements(
          PluginWithoutManifest as unknown as PluginConstructor,
        ),
      ).toThrow(ConfigurationError);
    });

    it("should return required resources with required=true", () => {
      const mockManifest: PluginManifest = {
        name: "test-plugin",
        displayName: "Test Plugin",
        description: "A test plugin",
        resources: {
          required: [
            {
              type: ResourceType.SQL_WAREHOUSE,
              alias: "warehouse",
              resourceKey: "warehouse",
              description: "Test warehouse",
              permission: "CAN_USE",
              fields: { id: { env: "TEST_WAREHOUSE_ID" } },
            },
          ],
          optional: [],
        },
      };

      class TestPlugin {
        static manifest = mockManifest;
      }

      const resources = getResourceRequirements(
        TestPlugin as unknown as PluginConstructor,
      );
      expect(resources).toHaveLength(1);
      expect(resources[0]).toMatchObject({
        type: ResourceType.SQL_WAREHOUSE,
        alias: "warehouse",
        required: true,
      });
    });

    it("should return optional resources with required=false", () => {
      const mockManifest: PluginManifest = {
        name: "test-plugin",
        displayName: "Test Plugin",
        description: "A test plugin",
        resources: {
          required: [],
          optional: [
            {
              type: ResourceType.SECRET,
              alias: "secrets",
              resourceKey: "secrets",
              description: "Optional secrets",
              permission: "READ",
              fields: {
                scope: { env: "TEST_SECRET_SCOPE" },
                key: { env: "TEST_SECRET_KEY" },
              },
            },
          ],
        },
      };

      class TestPlugin {
        static manifest = mockManifest;
      }

      const resources = getResourceRequirements(
        TestPlugin as unknown as PluginConstructor,
      );
      expect(resources).toHaveLength(1);
      expect(resources[0]).toMatchObject({
        type: ResourceType.SECRET,
        alias: "secrets",
        required: false,
      });
    });

    it("should return both required and optional resources", () => {
      const mockManifest: PluginManifest = {
        name: "test-plugin",
        displayName: "Test Plugin",
        description: "A test plugin",
        resources: {
          required: [
            {
              type: ResourceType.SQL_WAREHOUSE,
              alias: "warehouse",
              resourceKey: "warehouse",
              description: "Test warehouse",
              permission: "CAN_USE",
              fields: { id: { env: "TEST_WAREHOUSE_ID" } },
            },
          ],
          optional: [
            {
              type: ResourceType.SECRET,
              alias: "secrets",
              resourceKey: "secrets",
              description: "Optional secrets",
              permission: "READ",
              fields: {
                scope: { env: "TEST_SECRET_SCOPE" },
                key: { env: "TEST_SECRET_KEY" },
              },
            },
          ],
        },
      };

      class TestPlugin {
        static manifest = mockManifest;
      }

      const resources = getResourceRequirements(
        TestPlugin as unknown as PluginConstructor,
      );
      expect(resources).toHaveLength(2);
      expect(resources[0].required).toBe(true);
      expect(resources[1].required).toBe(false);
    });

    it("should return resources with fields for multi-field types", () => {
      const mockManifest: PluginManifest = {
        name: "test-plugin",
        displayName: "Test Plugin",
        description: "A test plugin",
        resources: {
          required: [
            {
              type: ResourceType.DATABASE,
              alias: "cache",
              resourceKey: "cache",
              description: "Database for caching",
              permission: "CAN_CONNECT_AND_CREATE",
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
            },
          ],
          optional: [],
        },
      };

      class TestPlugin {
        static manifest = mockManifest;
      }

      const resources = getResourceRequirements(
        TestPlugin as unknown as PluginConstructor,
      );
      expect(resources).toHaveLength(1);
      expect(resources[0]).toMatchObject({
        type: ResourceType.DATABASE,
        alias: "cache",
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
    });

    it("should return empty array for plugin with no resources", () => {
      const mockManifest: PluginManifest = {
        name: "test-plugin",
        displayName: "Test Plugin",
        description: "A test plugin",
        resources: {
          required: [],
          optional: [],
        },
      };

      class TestPlugin {
        static manifest = mockManifest;
      }

      const resources = getResourceRequirements(
        TestPlugin as unknown as PluginConstructor,
      );
      expect(resources).toHaveLength(0);
    });
  });

  describe("isValidManifest", () => {
    it("should return true for valid manifest", () => {
      const validManifest: PluginManifest = {
        name: "test",
        displayName: "Test",
        description: "Test plugin",
        resources: {
          required: [],
          optional: [],
        },
      };

      expect(isValidManifest(validManifest)).toBe(true);
    });

    it("should return false for null", () => {
      expect(isValidManifest(null)).toBe(false);
    });

    it("should return false for undefined", () => {
      expect(isValidManifest(undefined)).toBe(false);
    });

    it("should return false for non-object", () => {
      expect(isValidManifest("string")).toBe(false);
      expect(isValidManifest(123)).toBe(false);
      expect(isValidManifest(true)).toBe(false);
    });

    it("should return false for manifest missing name", () => {
      const invalid = {
        displayName: "Test",
        description: "Test",
        resources: { required: [], optional: [] },
      };

      expect(isValidManifest(invalid)).toBe(false);
    });

    it("should return false for manifest missing displayName", () => {
      const invalid = {
        name: "test",
        description: "Test",
        resources: { required: [], optional: [] },
      };

      expect(isValidManifest(invalid)).toBe(false);
    });

    it("should return false for manifest missing description", () => {
      const invalid = {
        name: "test",
        displayName: "Test",
        resources: { required: [], optional: [] },
      };

      expect(isValidManifest(invalid)).toBe(false);
    });

    it("should return false for manifest missing resources", () => {
      const invalid = {
        name: "test",
        displayName: "Test",
        description: "Test",
      };

      expect(isValidManifest(invalid)).toBe(false);
    });

    it("should return false for manifest with non-array required", () => {
      const invalid = {
        name: "test",
        displayName: "Test",
        description: "Test",
        resources: {
          required: "not-array",
          optional: [],
        },
      };

      expect(isValidManifest(invalid)).toBe(false);
    });

    it("should return false for manifest with non-array optional", () => {
      const invalid = {
        name: "test",
        displayName: "Test",
        description: "Test",
        resources: {
          required: [],
          optional: "not-array",
        },
      };

      expect(isValidManifest(invalid)).toBe(false);
    });

    it("should return true for manifest without optional field", () => {
      const valid = {
        name: "test",
        displayName: "Test",
        description: "Test",
        resources: {
          required: [],
        },
      };

      expect(isValidManifest(valid)).toBe(true);
    });

    it("should return true for manifest with additional fields", () => {
      const valid = {
        name: "test",
        displayName: "Test",
        description: "Test",
        resources: {
          required: [],
          optional: [],
        },
        author: "Test Author",
        version: "1.0.0",
        keywords: ["test"],
      };

      expect(isValidManifest(valid)).toBe(true);
    });
  });
});
