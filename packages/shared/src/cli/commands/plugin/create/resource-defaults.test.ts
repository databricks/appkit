import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIELDS_BY_TYPE,
  DEFAULT_PERMISSION_BY_TYPE,
  getDefaultFieldsForType,
  humanizeResourceType,
  RESOURCE_TYPE_OPTIONS,
  resourceKeyFromType,
} from "./resource-defaults";

describe("resource-defaults", () => {
  describe("humanizeResourceType", () => {
    it("returns the label for known types", () => {
      expect(humanizeResourceType("sql_warehouse")).toBe("SQL Warehouse");
      expect(humanizeResourceType("vector_search_index")).toBe(
        "Vector Search Index",
      );
      expect(humanizeResourceType("secret")).toBe("Secret");
      expect(humanizeResourceType("app")).toBe("App");
    });

    it("falls back to replacing underscores with spaces for unknown types", () => {
      expect(humanizeResourceType("custom_thing")).toBe("custom thing");
      expect(humanizeResourceType("no_underscores")).toBe("no underscores");
    });

    it("returns the type as-is when no underscores and unknown", () => {
      expect(humanizeResourceType("custom")).toBe("custom");
    });
  });

  describe("resourceKeyFromType", () => {
    it("converts underscores to hyphens", () => {
      expect(resourceKeyFromType("sql_warehouse")).toBe("sql-warehouse");
      expect(resourceKeyFromType("vector_search_index")).toBe(
        "vector-search-index",
      );
      expect(resourceKeyFromType("uc_function")).toBe("uc-function");
    });

    it("returns type unchanged when no underscores", () => {
      expect(resourceKeyFromType("secret")).toBe("secret");
      expect(resourceKeyFromType("app")).toBe("app");
    });
  });

  describe("getDefaultFieldsForType", () => {
    it("returns known fields for sql_warehouse", () => {
      const fields = getDefaultFieldsForType("sql_warehouse");
      expect(fields).toEqual({
        id: { env: "DATABRICKS_WAREHOUSE_ID", description: "SQL Warehouse ID" },
      });
    });

    it("returns known fields for secret (multi-field)", () => {
      const fields = getDefaultFieldsForType("secret");
      expect(fields).toHaveProperty("scope");
      expect(fields).toHaveProperty("key");
      expect(fields.scope.env).toBe("SECRET_SCOPE");
      expect(fields.key.env).toBe("SECRET_KEY");
    });

    it("returns known fields for database (multi-field)", () => {
      const fields = getDefaultFieldsForType("database");
      expect(fields).toHaveProperty("instance_name");
      expect(fields).toHaveProperty("database_name");
    });

    it("generates fallback fields for unknown types", () => {
      const fields = getDefaultFieldsForType("my_custom_resource");
      expect(fields).toEqual({
        id: {
          env: "DATABRICKS_MY_CUSTOM_RESOURCE_ID",
          description: "my custom resource ID",
        },
      });
    });

    it("generates correct env name for simple unknown type", () => {
      const fields = getDefaultFieldsForType("widget");
      expect(fields.id.env).toBe("DATABRICKS_WIDGET_ID");
    });
  });

  describe("constants coverage", () => {
    it("RESOURCE_TYPE_OPTIONS covers all DEFAULT_PERMISSION_BY_TYPE keys", () => {
      const optionValues = RESOURCE_TYPE_OPTIONS.map((o) => o.value);
      for (const key of Object.keys(DEFAULT_PERMISSION_BY_TYPE)) {
        expect(optionValues).toContain(key);
      }
    });

    it("DEFAULT_FIELDS_BY_TYPE has fields for all resource types with known multi-field layouts", () => {
      for (const key of Object.keys(DEFAULT_FIELDS_BY_TYPE)) {
        const fields = DEFAULT_FIELDS_BY_TYPE[key];
        for (const fieldEntry of Object.values(fields)) {
          expect(fieldEntry.env).toMatch(/^[A-Z][A-Z0-9_]*$/);
        }
      }
    });
  });
});
