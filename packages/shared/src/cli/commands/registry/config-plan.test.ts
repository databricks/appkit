import { describe, expect, it } from "vitest";
import { buildConfigPlan } from "./config-plan";
import type { ResourceRequirementRow } from "./requirements";

/** A DABs `${var.<name>}` reference, built to avoid a JS-template literal. */
function varRef(name: string): string {
  return "${var." + name + "}";
}

const WAREHOUSE: ResourceRequirementRow = {
  type: "sql_warehouse",
  resourceKey: "sql-warehouse",
  permission: "CAN_USE",
  required: true,
  fields: [{ key: "id", env: "DATABRICKS_WAREHOUSE_ID", origin: "user" }],
};

// Mirrors the postgres resource from the lakebase fixture manifest.
const POSTGRES: ResourceRequirementRow = {
  type: "postgres",
  resourceKey: "postgres",
  permission: "CAN_CONNECT_AND_CREATE",
  required: true,
  fields: [
    { key: "project", origin: "user" },
    { key: "branch", origin: "user" },
    { key: "database", origin: "user" },
    { key: "host", env: "PGHOST", origin: "platform", localOnly: true },
    { key: "endpointPath", env: "LAKEBASE_ENDPOINT", origin: "cli" },
    { key: "port", env: "PGPORT", origin: "platform", value: "5432" },
  ],
};

describe("buildConfigPlan — sql_warehouse", () => {
  it("produces the app.yaml env entry (valueFrom = resourceKey)", () => {
    const plan = buildConfigPlan([WAREHOUSE]);
    expect(plan.appYamlEnv).toEqual([
      { name: "DATABRICKS_WAREHOUSE_ID", valueFrom: "sql-warehouse" },
    ]);
  });

  it("produces the sql_warehouse_id bundle variable and binding", () => {
    const plan = buildConfigPlan([WAREHOUSE], {
      DATABRICKS_WAREHOUSE_ID: "abc123warehouse",
    });
    expect(plan.bundleVariables).toEqual([
      {
        name: "sql_warehouse_id",
        description: undefined,
        value: "abc123warehouse",
      },
    ]);
    expect(plan.resourceBindings).toEqual([
      {
        name: "sql-warehouse",
        type: "sql_warehouse",
        permission: "CAN_USE",
        fields: { id: varRef("sql_warehouse_id") },
      },
    ]);
    expect(plan.unverifiedTypes).toEqual([]);
  });
});

describe("buildConfigPlan — postgres", () => {
  it("binds only branch+database, but declares all three variables", () => {
    const plan = buildConfigPlan([POSTGRES], {
      // user-provided values keyed by field key (no env for these)
      project: "projects/p1",
      branch: "projects/p1/branches/b1",
      database: "projects/p1/branches/b1/databases/db1",
    });
    expect(plan.bundleVariables.map((v) => v.name)).toEqual([
      "postgres_project",
      "postgres_branch",
      "postgres_database",
    ]);
    expect(plan.resourceBindings).toEqual([
      {
        name: "postgres",
        type: "postgres",
        permission: "CAN_CONNECT_AND_CREATE",
        fields: {
          branch: varRef("postgres_branch"),
          database: varRef("postgres_database"),
        },
      },
    ]);
  });

  it("puts only cli-origin fields in app.yaml env (not platform)", () => {
    const plan = buildConfigPlan([POSTGRES]);
    expect(plan.appYamlEnv).toEqual([
      { name: "LAKEBASE_ENDPOINT", valueFrom: "postgres" },
    ]);
  });
});

describe("buildConfigPlan — unverified types", () => {
  it("still emits env but flags the type and writes no binding", () => {
    const genie: ResourceRequirementRow = {
      type: "genie_space",
      resourceKey: "genie-space",
      required: true,
      fields: [{ key: "id", env: "GENIE_SPACE_ID", origin: "user" }],
    };
    const plan = buildConfigPlan([genie]);
    expect(plan.appYamlEnv).toEqual([
      { name: "GENIE_SPACE_ID", valueFrom: "genie-space" },
    ]);
    expect(plan.resourceBindings).toEqual([]);
    expect(plan.bundleVariables).toEqual([]);
    expect(plan.unverifiedTypes).toEqual(["genie_space"]);
  });
});
