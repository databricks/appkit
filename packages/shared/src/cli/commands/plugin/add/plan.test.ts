import { describe, expect, test } from "vitest";

import {
  buildAddPlan,
  findMissingValues,
  type ManifestPlugin,
  parseSetAuthModes,
  parseSetValues,
  resolveAuthModes,
  selectResources,
  validSetKeys,
} from "./plan";

const warehouse = {
  type: "sql_warehouse",
  alias: "SQL Warehouse",
  resourceKey: "sql-warehouse",
  description: "Warehouse",
  permission: "CAN_USE",
  fields: { id: { env: "DATABRICKS_WAREHOUSE_ID", description: "id" } },
  scope: "sql",
  binding: { yamlKey: "sql_warehouse", varFields: [["id", "id"]] },
} satisfies ManifestPlugin["resources"]["required"][number];

const secret = {
  type: "secret",
  alias: "Secret",
  resourceKey: "secret",
  permission: "READ",
  fields: { key: { env: "SECRET_KEY" }, scope: { env: "SECRET_SCOPE" } },
  appOnly: true,
  binding: {
    yamlKey: "secret",
    varFields: [
      ["scope", "scope"],
      ["key", "key"],
    ],
  },
} satisfies ManifestPlugin["resources"]["optional"][number];

const job = {
  type: "job",
  alias: "Job",
  resourceKey: "job",
  permission: "CAN_MANAGE_RUN",
  fields: { id: { env: "DATABRICKS_JOB_ID" } },
  binding: { yamlKey: "job", varFields: [["id", "id"]] },
} satisfies ManifestPlugin["resources"]["optional"][number];

const plugin: ManifestPlugin = {
  name: "analytics",
  package: "@databricks/appkit",
  scopes: ["ai-gateway"],
  resources: { required: [warehouse], optional: [secret, job] },
};

describe("parseSetValues", () => {
  test("keys values by resourceKey.field and skips authMode", () => {
    expect(
      parseSetValues(
        [
          "analytics.sql-warehouse.id=wh",
          "analytics.sql-warehouse.authMode=obo",
        ],
        plugin,
      ),
    ).toEqual({ "sql-warehouse.id": "wh" });
  });

  test.each([
    ["other.sql-warehouse.id=x", "unknown plugin"],
    ["analytics.nope.id=x", "does not match a resource declared"],
    ["analytics.sql-warehouse=x", "invalid --set key"],
    ["analytics.secret.scope=s", "incomplete resource"],
  ])("%s → %s", (sv, err) => {
    expect(() => parseSetValues([sv], plugin)).toThrow(err);
  });
});

test("validSetKeys derives keys and values from the manifest", () => {
  const keys = validSetKeys(plugin);
  expect([...keys.keys()]).toEqual([
    "analytics.sql-warehouse.id",
    "analytics.sql-warehouse.authMode",
    "analytics.secret.key",
    "analytics.secret.scope",
    "analytics.job.id",
    "analytics.job.authMode",
  ]);
  expect(keys.get("analytics.job.authMode")).toEqual(["sp"]);
  expect(() =>
    parseSetValues(["analytics.sql-warehouse.name=x"], plugin),
  ).toThrow("valid keys: analytics.sql-warehouse.id");
  expect(() =>
    parseSetAuthModes(["analytics.nope.authMode=sp"], plugin),
  ).toThrow("does not match a resource declared");
});

describe("parseSetAuthModes", () => {
  test.each([
    ["analytics.sql-warehouse.authMode=user", "invalid auth mode"],
    ["analytics.secret.authMode=sp", "always accessed by the app's service"],
    ["analytics.job.authMode=obo", "cannot be accessed on behalf of the user"],
  ])("%s → %s", (sv, err) => {
    expect(() => parseSetAuthModes([sv], plugin)).toThrow(err);
  });

  test("accepts both and sp without scope", () => {
    expect(
      parseSetAuthModes(
        ["analytics.sql-warehouse.authMode=both", "analytics.job.authMode=sp"],
        plugin,
      ),
    ).toEqual({ "sql_warehouse:sql-warehouse": "both", "job:job": "sp" });
  });
});

test("resolveAuthModes: --set wins, obo default skips non-capable", () => {
  const { modes, keptSP } = resolveAuthModes(
    [warehouse, secret, job],
    {},
    {},
    "obo",
  );
  expect(modes).toEqual({ "sql_warehouse:sql-warehouse": "obo" });
  expect(keptSP).toEqual(["secret", "job"]);
  expect(
    resolveAuthModes(
      [warehouse],
      { "sql_warehouse:sql-warehouse": "sp" },
      {},
      "obo",
    ).modes,
  ).toEqual({});
});

describe("buildAddPlan", () => {
  const values = { "sql-warehouse.id": "wh", "job.id": "42" };
  const resources = selectResources(plugin, values);

  test("sp binds the resource with its permission and no scopes", () => {
    const plan = buildAddPlan(plugin, resources, values, {});
    expect(resources.map((r) => r.resourceKey)).toEqual([
      "sql-warehouse",
      "job",
    ]);
    expect(plan.userApiScopes).toEqual([]);
    expect(plan.appYamlEnv).toEqual([
      { name: "DATABRICKS_WAREHOUSE_ID", valueFrom: "sql-warehouse" },
      { name: "DATABRICKS_JOB_ID", valueFrom: "job" },
    ]);
    expect(plan.resourceBindings[0]).toEqual({
      name: "sql-warehouse",
      type: "sql_warehouse",
      permission: "CAN_USE",
      fields: { id: "${var.sql_warehouse_id}" },
    });
    expect(plan.bundleVariables[0]).toMatchObject({
      name: "sql_warehouse_id",
      value: "wh",
    });
    expect(plan.dotEnv).toContainEqual({
      env: "DATABRICKS_WAREHOUSE_ID",
      value: "wh",
    });
  });

  test("obo uses a literal value, no binding, and adds scopes", () => {
    const modes = { "sql_warehouse:sql-warehouse": "obo" } as const;
    const plan = buildAddPlan(plugin, resources, values, modes);
    expect(plan.appYamlEnv[0]).toEqual({
      name: "DATABRICKS_WAREHOUSE_ID",
      value: "wh",
    });
    expect(plan.resourceBindings.map((b) => b.name)).toEqual(["job"]);
    expect(plan.userApiScopes).toEqual(["sql", "ai-gateway"]);
  });

  test("both binds and adds the scope", () => {
    const modes = { "sql_warehouse:sql-warehouse": "both" } as const;
    const plan = buildAddPlan(plugin, resources, values, modes);
    expect(plan.resourceBindings.map((b) => b.name)).toEqual([
      "sql-warehouse",
      "job",
    ]);
    expect(plan.userApiScopes).toEqual(["sql", "ai-gateway"]);
  });
});

test("findMissingValues names the --set key", () => {
  expect(
    findMissingValues("analytics", [warehouse], {}, {}).map((m) => m.setKey),
  ).toEqual(["analytics.sql-warehouse.id"]);
});
