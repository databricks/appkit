import { describe, expect, test } from "vitest";

import {
  APP_ONLY_RESOURCE_TYPES,
  DABS_BINDING_BY_TYPE,
  pluginManifestSchema,
  resourceRequirementSchema,
  SCOPE_BY_TYPE,
} from "./manifest";

const manifest = {
  name: "testPlugin",
  displayName: "Test Plugin",
  description: "A test plugin",
  resources: { required: [], optional: [] },
};

describe("manifest execution capabilities", () => {
  test("only maps resource types with confirmed user scopes", () => {
    expect(SCOPE_BY_TYPE).toEqual({
      sql_warehouse: "sql",
      serving_endpoint: "model-serving",
      genie_space: "genie",
      volume: "files",
      vector_search_index: "vector-search",
      uc_connection: "catalog.connections",
    });
    expect([...APP_ONLY_RESOURCE_TYPES]).toEqual([
      "secret",
      "database",
      "postgres",
    ]);
  });

  test("preserves manifests with no authored scopes", () => {
    expect(pluginManifestSchema.parse(manifest)).toEqual(manifest);
    expect(
      pluginManifestSchema.parse({ ...manifest, scopes: [] }).scopes,
    ).toEqual([]);
  });

  test("accepts every user_api_scope as an authored plugin scope", () => {
    const scopes = [
      "sql",
      "sql:restricted-query",
      "genie",
      "postgres",
      "model-serving",
      "files",
      "vector-search",
      "catalog.connections",
      "ai-gateway",
      "mcp.external",
      "mcp.functions",
      "workspace.workspace",
      "catalog.catalogs:read",
      "catalog.schemas:read",
      "catalog.tables:read",
    ];
    expect(pluginManifestSchema.parse({ ...manifest, scopes }).scopes).toEqual(
      scopes,
    );
  });

  test.each([
    "mlflow",
    "jobs",
    "apps",
    "dashboards.genie",
    "files.files",
    "serving.serving-endpoints",
    "unknown",
  ])("rejects %s as an authored plugin scope", (scope) => {
    expect(
      pluginManifestSchema.safeParse({ ...manifest, scopes: [scope] }).success,
    ).toBe(false);
  });

  test("rejects malformed scopes and per-plugin authMode", () => {
    expect(
      pluginManifestSchema.safeParse({ ...manifest, scopes: "ai-gateway" })
        .success,
    ).toBe(false);
    expect(
      pluginManifestSchema.safeParse({ ...manifest, scopes: [123] }).success,
    ).toBe(false);
    expect(
      pluginManifestSchema.safeParse({ ...manifest, authMode: "obo" }).success,
    ).toBe(false);
  });

  test("model_service resource type validates with EXECUTE permission", () => {
    const resource = {
      type: "model_service",
      alias: "Model Service",
      resourceKey: "model-service",
      description: "Unity AI Gateway model service",
      permission: "EXECUTE",
      fields: { name: { env: "DATABRICKS_MODEL_SERVICE_NAME" } },
    };
    const result = resourceRequirementSchema.safeParse(resource);
    expect(result.success).toBe(true);
  });

  test("model_service resource type rejects non-EXECUTE permissions", () => {
    const resource = {
      type: "model_service",
      alias: "Model Service",
      resourceKey: "model-service",
      description: "Unity AI Gateway model service",
      permission: "CAN_USE",
      fields: { name: { env: "DATABRICKS_MODEL_SERVICE_NAME" } },
    };
    const result = resourceRequirementSchema.safeParse(resource);
    expect(result.success).toBe(false);
  });

  test("model_service has correct DABs binding with uc_securable", () => {
    expect(DABS_BINDING_BY_TYPE.model_service).toEqual({
      yamlKey: "uc_securable",
      varFields: [["name", "securable_full_name"]],
      staticFields: [["securable_type", "MODEL_SERVICE"]],
    });
  });

  test("model_service is not in SCOPE_BY_TYPE (SP-only, no OBO)", () => {
    expect(SCOPE_BY_TYPE).not.toHaveProperty("model_service");
  });

  test("model_service is not in APP_ONLY_RESOURCE_TYPES", () => {
    expect(APP_ONLY_RESOURCE_TYPES.has("model_service")).toBe(false);
  });
});
