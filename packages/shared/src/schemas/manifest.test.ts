import { describe, expect, test } from "vitest";

import {
  APP_ONLY_RESOURCE_TYPES,
  pluginManifestSchema,
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

  test("accepts every capability-only scope without resource IDs", () => {
    const scopes = [
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
    "sql",
    "sql:restricted-query",
    "postgres",
    "genie",
    "model-serving",
    "files",
    "vector-search",
    "catalog.connections",
    "mlflow",
    "jobs",
    "apps",
    "dashboards.genie",
    "files.files",
    "serving.serving-endpoints",
    "unknown",
  ])("rejects %s as an authored capability-only scope", (scope) => {
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
});
