import { describe, expect, it } from "vitest";

import { buildConfigPlan, collectBindingValueNeeds } from "./config-plan";
import type { ResourceRequirementRow } from "./requirements";

/** A DABs `${var.<name>}` reference (literal bundle syntax, not JS interp). */
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

describe("buildConfigPlan — malformed env names", () => {
  it("drops a field whose env name is not a plain identifier", () => {
    const plan = buildConfigPlan([
      {
        type: "sql_warehouse",
        resourceKey: "sql-warehouse",
        permission: "CAN_USE",
        required: true,
        fields: [
          // untrusted manifest name with an injected line
          { key: "id", env: "X\nINJECTED=1", origin: "user" },
        ],
      },
    ]);
    expect(plan.appYamlEnv).toEqual([]);
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

describe("collectBindingValueNeeds", () => {
  it("reports postgres binding fields that have no env name", () => {
    // project/branch/database carry bundle variables but no env → the .env
    // flow never collects them; they must be gathered separately or the
    // databricks.yml target variables stay unassigned.
    const needs = collectBindingValueNeeds([POSTGRES]);
    expect(needs.map((n) => n.fieldKey)).toEqual([
      "project",
      "branch",
      "database",
    ]);
    expect(needs.every((n) => n.resourceType === "postgres")).toBe(true);
  });

  it("does not report sql_warehouse (its binding field has an env name)", () => {
    expect(collectBindingValueNeeds([WAREHOUSE])).toEqual([]);
  });

  it("ignores unverified types (no binding spec)", () => {
    const genie: ResourceRequirementRow = {
      type: "genie_space",
      resourceKey: "genie-space",
      required: true,
      fields: [{ key: "id", env: "GENIE_SPACE_ID", origin: "user" }],
    };
    expect(collectBindingValueNeeds([genie])).toEqual([]);
  });
});
