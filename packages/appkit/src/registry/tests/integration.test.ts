import { describe, expect, it } from "vitest";
import { AnalyticsPlugin } from "../../plugins/analytics/analytics";
import { ServerPlugin } from "../../plugins/server";
import { getPluginManifest, getResourceRequirements } from "../manifest-loader";
import { ResourceType } from "../types";

describe("Manifest Loader Integration", () => {
  describe("ServerPlugin", () => {
    it("should load manifest successfully", () => {
      const manifest = getPluginManifest(ServerPlugin);
      expect(manifest).not.toBeNull();
      expect(manifest?.name).toBe("server");
      expect(manifest?.displayName).toBe("Server Plugin");
    });

    it("should have no required resources", () => {
      const resources = getResourceRequirements(ServerPlugin);
      expect(resources).toHaveLength(0);
    });
  });

  describe("AnalyticsPlugin", () => {
    it("should load manifest successfully", () => {
      const manifest = getPluginManifest(AnalyticsPlugin);
      expect(manifest).not.toBeNull();
      expect(manifest?.name).toBe("analytics");
      expect(manifest?.displayName).toBe("Analytics Plugin");
    });

    it("should require SQL Warehouse (no optional resources in manifest)", () => {
      const resources = getResourceRequirements(AnalyticsPlugin);
      expect(resources).toHaveLength(1);

      const required = resources.find((r) => r.required);
      expect(required).toBeDefined();

      expect(required).toMatchObject({
        type: ResourceType.SQL_WAREHOUSE,
        resourceKey: "sql-warehouse",
        required: true,
        permission: "CAN_USE",
        fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
      });
    });

    it("should have correct resource description", () => {
      const manifest = getPluginManifest(AnalyticsPlugin);
      expect(manifest?.resources.required[0].description).toBe(
        "SQL Warehouse for executing analytics queries",
      );
    });
  });
});
